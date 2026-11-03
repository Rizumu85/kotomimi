// vr-overlay/src/main.cpp
//
// Fork: Kotomimi's SteamVR overlay helper. Electron
// draws the caption strip and the wrist panel offscreen and writes each new
// picture to this process's stdin; this process puts them into SteamVR, keeps
// the strip under the line of sight and the panel on a wrist, turns the other
// hand's poke into pointer events, and reports the headset's frame rate and
// the graphics card's memory — one JSON line each, on stdout.
//
// stdin: messages of [u32 kind][u32 length][payload], little-endian.
//   kind 1, config: lines of "key value..." (see applyConfig).
//   kind 2, picture: [u8 overlay (0 strip, 1 wrist)][3 pad][u32 width][u32 height], then BGRA, premultiplied.
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
constexpr int kWrist = 1;
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
  Picture pictures[2];
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
      if (which > 1 || w == 0 || h == 0 || w > kMaxSide || h > kMaxSide || payload.size() != 12 + size_t(w) * h * 4) continue;
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
  bool leftHand = true;
  Vec3 wristAt = {0.0f, 0.03f, 0.13f};
  Vec3 wristTurn = {0, 0, 0};
  float wristWidth = 0.13f;
  bool wristAlways = false;
  bool wristOn = true;
  float stripWidth = 0.8f;
  bool stripOn = true;
  StripConfig strip;
  Vec3 pokeTip = {0.0f, -0.015f, -0.06f};
  PokeConfig poke;
  bool quit = false;
};

void applyConfig(Config& c, const std::string& text, bool& placementChanged) {
  std::istringstream lines(text);
  std::string line;
  while (std::getline(lines, line)) {
    std::istringstream in(line);
    std::string key;
    in >> key;
    if (key == "wrist.hand") {
      std::string hand;
      in >> hand;
      c.leftHand = hand != "right";
      placementChanged = true;
    } else if (key == "wrist.at") {
      in >> c.wristAt.x >> c.wristAt.y >> c.wristAt.z;
      placementChanged = true;
    } else if (key == "wrist.turn") {
      in >> c.wristTurn.x >> c.wristTurn.y >> c.wristTurn.z;
      placementChanged = true;
    } else if (key == "wrist.width") {
      in >> c.wristWidth;
      placementChanged = true;
    } else if (key == "wrist.always") {
      in >> c.wristAlways;
    } else if (key == "wrist.on") {
      in >> c.wristOn;
    } else if (key == "strip.width") {
      in >> c.stripWidth;
      placementChanged = true;
    } else if (key == "strip.on") {
      in >> c.stripOn;
    } else if (key == "strip.distance") {
      in >> c.strip.distance;
    } else if (key == "strip.below") {
      in >> c.strip.below;
    } else if (key == "poke.tip") {
      in >> c.pokeTip.x >> c.pokeTip.y >> c.pokeTip.z;
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
    if (!openDevice() || !create(kStrip, "kotomimi.captions", "Kotomimi captions") || !create(kWrist, "kotomimi.wrist", "Kotomimi")) {
      close();
      status("error", "could not create the overlays");
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
      for (int i = 0; i < 2; i++) {
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
      if (event.eventType == vr::VREvent_TrackedDeviceRoleChanged || event.eventType == vr::VREvent_TrackedDeviceActivated ||
          event.eventType == vr::VREvent_TrackedDeviceDeactivated) {
        placementChanged = true;
      }
    }

    if (placementChanged || !placed_) place(config);
    track(config);
    perf();
    return true;
  }

 private:
  bool openDevice() {
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
    return SUCCEEDED(hr);
  }

  bool create(int which, const char* key, const char* name) {
    Surface& s = surfaces_[which];
    if (vr::VROverlay()->CreateOverlay(key, name, &s.handle) != vr::VROverlayError_None) return false;
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
    overlay->SetOverlayWidthInMeters(surfaces_[kWrist].handle, c.wristWidth);
    auto role = c.leftHand ? vr::TrackedControllerRole_LeftHand : vr::TrackedControllerRole_RightHand;
    auto other = c.leftHand ? vr::TrackedControllerRole_RightHand : vr::TrackedControllerRole_LeftHand;
    wristDevice_ = vr::VRSystem()->GetTrackedDeviceIndexForControllerRole(role);
    pokeDevice_ = vr::VRSystem()->GetTrackedDeviceIndexForControllerRole(other);
    wristOffset_ = wristOffset(c.leftHand, c.wristAt, c.wristTurn);
    placed_ = true;
    if (wristDevice_ != vr::k_unTrackedDeviceIndexInvalid) {
      vr::HmdMatrix34_t m = toVr(wristOffset_);
      overlay->SetOverlayTransformTrackedDeviceRelative(surfaces_[kWrist].handle, wristDevice_, &m);
    }
  }

  void show(int which, bool on) {
    Surface& s = surfaces_[which];
    on = on && s.hasPicture;
    if (on == s.shown) return;
    s.shown = on;
    if (on) vr::VROverlay()->ShowOverlay(s.handle);
    else vr::VROverlay()->HideOverlay(s.handle);
    if (which == kWrist) emit(std::string("{\"t\":\"wrist\",\"shown\":") + (on ? "true" : "false") + "}");
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
      show(kWrist, false);
      return;
    }
    Mat34 head = toMat(hmd.mDeviceToAbsoluteTracking);

    // The strip, under the line of sight.
    if (c.stripOn && surfaces_[kStrip].hasPicture) {
      vr::HmdMatrix34_t m = toVr(followStrip(follow_, head, dt, c.strip));
      vr::VROverlay()->SetOverlayTransformAbsolute(surfaces_[kStrip].handle, vr::TrackingUniverseStanding, &m);
    }
    show(kStrip, c.stripOn);

    // The wrist panel, while looked at; the other hand presses it.
    bool wristTracked = wristDevice_ < vr::k_unMaxTrackedDeviceCount && poses[wristDevice_].bPoseIsValid;
    Mat34 panel = wristTracked ? mul(toMat(poses[wristDevice_].mDeviceToAbsoluteTracking), wristOffset_) : identity();
    Surface& wrist = surfaces_[kWrist];
    bool want = c.wristOn && wristTracked && (c.wristAlways || facesEyes(panel, head, wrist.shown));
    show(kWrist, want);
    if (!wrist.shown) {
      if (poke_.hovering || poke_.down) pointer(PokeEvent::Leave);
      poke_ = Poke{};
      return;
    }
    if (pokeDevice_ >= vr::k_unMaxTrackedDeviceCount || !poses[pokeDevice_].bPoseIsValid) return;
    Vec3 tip = apply(toMat(poses[pokeDevice_].mDeviceToAbsoluteTracking), c.pokeTip);
    Vec3 local = apply(inverseRigid(panel), tip);
    float lastU = poke_.u, lastV = poke_.v;
    PokeEvent e = updatePoke(poke_, local, c.wristWidth, heightOf(wrist, c.wristWidth), c.poke);
    // A hover that did not move is not news.
    if (e == PokeEvent::Hover && std::fabs(poke_.u - lastU) < 0.003f && std::fabs(poke_.v - lastV) < 0.003f) return;
    if (e != PokeEvent::None) pointer(e);
  }

  void pointer(PokeEvent e) {
    const char* kind = e == PokeEvent::Hover ? "move" : e == PokeEvent::Down ? "down" : e == PokeEvent::Up ? "up" : "leave";
    char line[160];
    std::snprintf(line, sizeof line, "{\"t\":\"pointer\",\"o\":\"wrist\",\"kind\":\"%s\",\"u\":%.4f,\"v\":%.4f}", kind, poke_.u, poke_.v);
    emit(line);
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
  Surface surfaces_[2];
  vr::TrackedDeviceIndex_t wristDevice_ = vr::k_unTrackedDeviceIndexInvalid;
  vr::TrackedDeviceIndex_t pokeDevice_ = vr::k_unTrackedDeviceIndexInvalid;
  Mat34 wristOffset_ = identity();
  bool placed_ = false;
  LazyFollow follow_;
  Poke poke_;
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
    while (!inbox.closed && !config.quit && session.tick(inbox, config)) {
      if (vr::VROverlay()->WaitFrameSync(20) != vr::VROverlayError_None) Sleep(11);
    }
    session.close();
    status("waiting");
    Sleep(2000);
  }
  return 0;
}
