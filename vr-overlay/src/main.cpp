// vr-overlay/src/main.cpp
//
// Fork: Kotomimi's SteamVR overlay helper. Electron
// draws the caption strip offscreen and writes each new picture to this
// process's stdin; this process puts it into SteamVR, keeps it under the line
// of sight, and reports the headset's frame rate and the graphics card's
// memory — one JSON line each, on stdout. The wrist panel is not drawn here:
// it is a window on the desktop, which a wrist tool such as XSOverlay shows.
//
// stdin: messages of [u32 kind][u32 length][payload], little-endian.
//   kind 1, config: lines of "key value..." (see applyConfig).
//   kind 2, picture: [u8 overlay (0, the strip)][3 pad][u32 width][u32 height], then BGRA, premultiplied.
// It ends when stdin closes.
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <tlhelp32.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include <openvr.h>

#include "geometry.h"
#include "gpu_memory.h"

namespace {

constexpr int kStrip = 0;
constexpr uint32_t kMaxSide = 4096;

// ── Output ────────────────────────────────────────────────────────────────
void emit(const std::string& json) {
  std::fwrite(json.data(), 1, json.size(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

void status(const char* state, const char* detail = nullptr) {
  std::string line = std::string("{\"t\":\"status\",\"vr\":\"") + state + "\"";
  if (detail) line += std::string(",\"detail\":\"") + detail + "\"";
  emit(line + "}");
}

// ── Input from Electron ───────────────────────────────────────────────────
struct Picture {
  uint32_t width = 0, height = 0;
  std::vector<uint8_t> pixels;
  bool fresh = false;
};

struct Inbox {
  std::mutex lock;
  Picture pictures[1];
  std::string config;
  std::atomic<bool> closed{false};
};

bool readExact(HANDLE in, void* to, DWORD n) {
  auto* p = static_cast<uint8_t*>(to);
  while (n > 0) {
    DWORD got = 0;
    if (!ReadFile(in, p, n, &got, nullptr) || got == 0) return false;
    p += got;
    n -= got;
  }
  return true;
}

void readInput(Inbox* inbox) {
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  std::vector<uint8_t> payload;
  for (;;) {
    uint32_t head[2];
    if (!readExact(in, head, sizeof head)) break;
    if (head[1] > 12 + kMaxSide * kMaxSide * 4) break;
    payload.resize(head[1]);
    if (head[1] > 0 && !readExact(in, payload.data(), head[1])) break;
    std::lock_guard<std::mutex> hold(inbox->lock);
    if (head[0] == 1) {
      inbox->config.append(reinterpret_cast<char*>(payload.data()), payload.size());
      inbox->config.push_back('\n');
    } else if (head[0] == 2 && payload.size() >= 12) {
      uint32_t which = payload[0], w, h;
      std::memcpy(&w, &payload[4], 4);
      std::memcpy(&h, &payload[8], 4);
      if (which > 0 || w == 0 || h == 0 || w > kMaxSide || h > kMaxSide || payload.size() != 12 + size_t(w) * h * 4) continue;
      Picture& pic = inbox->pictures[which];
      pic.width = w;
      pic.height = h;
      pic.pixels.assign(payload.begin() + 12, payload.end());
      pic.fresh = true;
    }
  }
  inbox->closed = true;
}

// ── Settings Electron sends ───────────────────────────────────────────────
struct Config {
  float stripWidth = 0.8f;
  bool stripOn = true;
  StripConfig strip;
  bool quit = false;
};

void applyConfig(Config& c, const std::string& text, bool& placementChanged) {
  std::istringstream lines(text);
  std::string line;
  while (std::getline(lines, line)) {
    std::istringstream in(line);
    std::string key;
    in >> key;
    if (key == "strip.width") {
      in >> c.stripWidth;
      placementChanged = true;
    } else if (key == "strip.on") {
      in >> c.stripOn;
    } else if (key == "strip.distance") {
      in >> c.strip.distance;
    } else if (key == "strip.below") {
      in >> c.strip.below;
    } else if (key == "quit") {
      c.quit = true;
    }
  }
}

// ── SteamVR ───────────────────────────────────────────────────────────────
bool steamVRRunning() {
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return false;
  PROCESSENTRY32W entry{sizeof entry};
  bool found = false;
  for (BOOL ok = Process32FirstW(snap, &entry); ok; ok = Process32NextW(snap, &entry)) {
    if (_wcsicmp(entry.szExeFile, L"vrserver.exe") == 0) {
      found = true;
      break;
    }
  }
  CloseHandle(snap);
  return found;
}

Mat34 toMat(const vr::HmdMatrix34_t& m) {
  Mat34 r;
  std::memcpy(r.m, m.m, sizeof r.m);
  return r;
}
vr::HmdMatrix34_t toVr(const Mat34& m) {
  vr::HmdMatrix34_t r;
  std::memcpy(r.m, m.m, sizeof r.m);
  return r;
}

struct Surface {
  vr::VROverlayHandle_t handle = vr::k_ulOverlayHandleInvalid;
  ID3D11Texture2D* texture = nullptr;
  uint32_t width = 0, height = 0;
  bool hasPicture = false;
  bool shown = false;
};

class Session {
 public:
  bool open() {
    vr::EVRInitError err = vr::VRInitError_None;
    vr::VR_Init(&err, vr::VRApplication_Overlay);
    if (err != vr::VRInitError_None) {
      status("error", vr::VR_GetVRInitErrorAsEnglishDescription(err));
      return false;
    }
    // Which step failed, and SteamVR's word for why: what a person's report can be read by.
    std::string why;
    if (!openDevice(why)) why = "could not open the graphics device: " + why;
    else if (!create(kStrip, "kotomimi.captions", "Kotomimi captions", why)) why = "could not create the overlays: " + why;
    if (!why.empty()) {
      close();
      status("error", why.c_str());
      return false;
    }
    vr::VROverlay()->SetOverlaySortOrder(surfaces_[kStrip].handle, 10);
    hz_ = vr::VRSystem()->GetFloatTrackedDeviceProperty(vr::k_unTrackedDeviceIndex_Hmd, vr::Prop_DisplayFrequency_Float);
    status("connected");
    return true;
  }

  void close() {
    for (Surface& s : surfaces_) {
      if (s.handle != vr::k_ulOverlayHandleInvalid && vr::VROverlay()) vr::VROverlay()->DestroyOverlay(s.handle);
      if (s.texture) s.texture->Release();
      s = Surface{};
    }
    if (context_) context_->Release();
    if (device_) device_->Release();
    context_ = nullptr;
    device_ = nullptr;
    vr::VR_Shutdown();
  }

  /** One pass: false once SteamVR is quitting. */
  bool tick(Inbox& inbox, Config& config) {
    bool placementChanged = false;
    {
      std::lock_guard<std::mutex> hold(inbox.lock);
      if (!inbox.config.empty()) {
        applyConfig(config, inbox.config, placementChanged);
        inbox.config.clear();
      }
      for (int i = 0; i < 1; i++) {
        Picture& pic = inbox.pictures[i];
        if (!pic.fresh) continue;
        upload(i, pic);
        pic.fresh = false;
        placementChanged = true;
      }
    }

    vr::VREvent_t event;
    while (vr::VRSystem()->PollNextEvent(&event, sizeof event)) {
      if (event.eventType == vr::VREvent_Quit) {
        vr::VRSystem()->AcknowledgeQuit_Exiting();
        return false;
      }
    }

    if (placementChanged || !placed_) place(config);
    track(config);
    perf();
    return true;
  }

 private:
  bool openDevice(std::string& why) {
    int32_t index = -1;
    vr::VRSystem()->GetDXGIOutputInfo(&index);
    IDXGIFactory1* factory = nullptr;
    IDXGIAdapter1* adapter = nullptr;
    if (index >= 0 && SUCCEEDED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(&factory)))) {
      if (factory->EnumAdapters1(index, &adapter) != S_OK) adapter = nullptr;
      factory->Release();
    }
    HRESULT hr = D3D11CreateDevice(adapter, adapter ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE, nullptr,
                                   D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, &device_, nullptr, &context_);
    if (adapter) adapter->Release();
    if (FAILED(hr)) {
      char text[96];
      std::snprintf(text, sizeof text, "adapter %d, HRESULT 0x%08lx", index, static_cast<unsigned long>(hr));
      why = text;
    }
    return SUCCEEDED(hr);
  }

  bool create(int which, const char* key, const char* name, std::string& why) {
    Surface& s = surfaces_[which];
    vr::EVROverlayError error = vr::VROverlay()->CreateOverlay(key, name, &s.handle);
    if (error != vr::VROverlayError_None) {
      why = std::string(key) + " " + vr::VROverlay()->GetOverlayErrorNameFromEnum(error);
      return false;
    }
    vr::VROverlay()->SetOverlayFlag(s.handle, vr::VROverlayFlags_IsPremultiplied, true);
    vr::VROverlay()->SetOverlayFlag(s.handle, vr::VROverlayFlags_NoBackside, true);
    return true;
  }

  void upload(int which, const Picture& pic) {
    Surface& s = surfaces_[which];
    if (!s.texture || s.width != pic.width || s.height != pic.height) {
      if (s.texture) s.texture->Release();
      s.texture = nullptr;
      D3D11_TEXTURE2D_DESC desc{};
      desc.Width = pic.width;
      desc.Height = pic.height;
      desc.MipLevels = 1;
      desc.ArraySize = 1;
      desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
      desc.SampleDesc.Count = 1;
      desc.Usage = D3D11_USAGE_DEFAULT;
      desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
      if (FAILED(device_->CreateTexture2D(&desc, nullptr, &s.texture))) return;
      s.width = pic.width;
      s.height = pic.height;
    }
    context_->UpdateSubresource(s.texture, 0, nullptr, pic.pixels.data(), pic.width * 4, 0);
    context_->Flush();
    vr::Texture_t texture{s.texture, vr::TextureType_DirectX, vr::ColorSpace_Auto};
    vr::VROverlay()->SetOverlayTexture(s.handle, &texture);
    s.hasPicture = true;
  }

  float heightOf(const Surface& s, float width) const { return s.width ? width * float(s.height) / float(s.width) : 0.0f; }

  void place(const Config& c) {
    vr::IVROverlay* overlay = vr::VROverlay();
    overlay->SetOverlayWidthInMeters(surfaces_[kStrip].handle, c.stripWidth);
    placed_ = true;
  }

  void show(int which, bool on) {
    Surface& s = surfaces_[which];
    on = on && s.hasPicture;
    if (on == s.shown) return;
    s.shown = on;
    if (on) vr::VROverlay()->ShowOverlay(s.handle);
    else vr::VROverlay()->HideOverlay(s.handle);
  }

  void track(const Config& c) {
    float sinceVsync = 0;
    uint64_t frame = 0;
    vr::VRSystem()->GetTimeSinceLastVsync(&sinceVsync, &frame);
    float toPhotons = vr::VRSystem()->GetFloatTrackedDeviceProperty(vr::k_unTrackedDeviceIndex_Hmd, vr::Prop_SecondsFromVsyncToPhotons_Float);
    float frameTime = hz_ > 0 ? 1.0f / hz_ : 0.011f;
    vr::TrackedDevicePose_t poses[vr::k_unMaxTrackedDeviceCount];
    vr::VRSystem()->GetDeviceToAbsoluteTrackingPose(vr::TrackingUniverseStanding, frameTime - sinceVsync + toPhotons, poses, vr::k_unMaxTrackedDeviceCount);

    auto now = std::chrono::steady_clock::now();
    float dt = std::chrono::duration<float>(now - lastTrack_).count();
    lastTrack_ = now;
    if (dt > 0.1f) dt = 0.1f;

    const vr::TrackedDevicePose_t& hmd = poses[vr::k_unTrackedDeviceIndex_Hmd];
    if (!hmd.bPoseIsValid) {
      show(kStrip, false);
      return;
    }
    Mat34 head = toMat(hmd.mDeviceToAbsoluteTracking);

    // The strip, under the line of sight.
    if (c.stripOn && surfaces_[kStrip].hasPicture) {
      vr::HmdMatrix34_t m = toVr(followStrip(follow_, head, dt, c.strip));
      vr::VROverlay()->SetOverlayTransformAbsolute(surfaces_[kStrip].handle, vr::TrackingUniverseStanding, &m);
    }
    show(kStrip, c.stripOn);
  }

  void perf() {
    auto now = std::chrono::steady_clock::now();
    float since = std::chrono::duration<float>(now - lastPerf_).count();
    if (since < 1.0f) return;
    lastPerf_ = now;
    vr::Compositor_CumulativeStats s{};
    bool haveStats = vr::VRCompositor() != nullptr;
    if (haveStats) vr::VRCompositor()->GetCumulativeStats(&s, sizeof s);
    GpuMemory memory = gpu_.read();
    char line[320];
    if (haveStats && s.m_nPid == lastStats_.m_nPid && s.m_nPid != 0) {
      std::snprintf(line, sizeof line,
                    "{\"t\":\"perf\",\"hz\":%.1f,\"presents\":%.1f,\"dropped\":%.1f,\"reprojected\":%.1f,\"pid\":%u,\"vramUsed\":%llu,\"vramTotal\":%llu}",
                    hz_, (s.m_nNumFramePresents - lastStats_.m_nNumFramePresents) / since,
                    (s.m_nNumDroppedFrames - lastStats_.m_nNumDroppedFrames) / since,
                    (s.m_nNumReprojectedFrames - lastStats_.m_nNumReprojectedFrames) / since, s.m_nPid,
                    memory.ok ? static_cast<unsigned long long>(memory.used) : 0ULL, memory.ok ? static_cast<unsigned long long>(memory.total) : 0ULL);
    } else {
      // No game in front, or a new one: frames are counted from the next second.
      std::snprintf(line, sizeof line, "{\"t\":\"perf\",\"hz\":%.1f,\"vramUsed\":%llu,\"vramTotal\":%llu}", hz_,
                    memory.ok ? static_cast<unsigned long long>(memory.used) : 0ULL, memory.ok ? static_cast<unsigned long long>(memory.total) : 0ULL);
    }
    lastStats_ = s;
    emit(line);
  }

  ID3D11Device* device_ = nullptr;
  ID3D11DeviceContext* context_ = nullptr;
  Surface surfaces_[1];
  bool placed_ = false;
  LazyFollow follow_;
  float hz_ = 0;
  std::chrono::steady_clock::time_point lastTrack_ = std::chrono::steady_clock::now();
  std::chrono::steady_clock::time_point lastPerf_ = std::chrono::steady_clock::now();
  vr::Compositor_CumulativeStats lastStats_{};
  GpuMemoryReader gpu_;
};

}  // namespace

int main() {
  std::setvbuf(stdout, nullptr, _IOFBF, 1 << 14);
  Inbox inbox;
  std::thread reader(readInput, &inbox);
  reader.detach();
  Config config;
  status("waiting");

  // A test without SteamVR: said to be shown at once, the pictures taken and dropped, the card's memory real.
  if (GetEnvironmentVariableW(L"KOTOMIMI_VR_FAKE", nullptr, 0) > 0) {
    status("connected");
    GpuMemoryReader gpu;
    while (!inbox.closed) {
      GpuMemory memory = gpu.read();
      char line[200];
      std::snprintf(line, sizeof line, "{\"t\":\"perf\",\"hz\":90.0,\"presents\":89.6,\"dropped\":0.0,\"reprojected\":0.0,\"vramUsed\":%llu,\"vramTotal\":%llu}",
                    static_cast<unsigned long long>(memory.used), static_cast<unsigned long long>(memory.total));
      emit(line);
      Sleep(1000);
    }
    return 0;
  }

  while (!inbox.closed && !config.quit) {
    if (!steamVRRunning()) {
      // Not running: what arrives is kept for when it is.
      {
        std::lock_guard<std::mutex> hold(inbox.lock);
        bool ignored = false;
        if (!inbox.config.empty()) applyConfig(config, inbox.config, ignored);
        inbox.config.clear();
      }
      Sleep(1000);
      continue;
    }
    Session session;
    if (!session.open()) {
      Sleep(5000);
      continue;
    }
    {
      // Pictures that came while waiting go up at once.
      std::lock_guard<std::mutex> hold(inbox.lock);
      for (Picture& pic : inbox.pictures) pic.fresh = !pic.pixels.empty();
    }
    auto checked = std::chrono::steady_clock::now();
    while (!inbox.closed && !config.quit && session.tick(inbox, config)) {
      if (vr::VROverlay()->WaitFrameSync(20) != vr::VROverlayError_None) Sleep(11);
      // SteamVR gone without saying so (it crashed, or was ended): nothing more is asked of it.
      if (std::chrono::steady_clock::now() - checked > std::chrono::seconds(2)) {
        checked = std::chrono::steady_clock::now();
        if (!steamVRRunning()) break;
      }
    }
    session.close();
    status("waiting");
    // SteamVR quitting stays up a while: connecting to it then would start it again. Wait for it to be gone.
    while (!inbox.closed && steamVRRunning()) Sleep(1000);
  }
  return 0;
}
