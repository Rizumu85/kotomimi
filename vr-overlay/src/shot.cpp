// Fork: one picture of the VRChat window, for the pictures a developer collects to train the app's own chat-bubble
// detector (electron/ocr-shots.js starts it every so often while a session runs, where KOTOMIMI_OCR_SHOTS names a
// folder). It runs once and ends: nothing stays in memory between pictures, and the game is asked for one frame.
//
//   kotomimi-shot <out.jpg> [--last <signature>]
//
// One line of JSON on stdout says what happened:
//   {"state":"saved","width":W,"height":H,"signature":"…"}   the picture is at <out.jpg>
//   {"state":"same","signature":"…"}                          it looks like the last one (`--last`): nothing written
//   {"state":"none"}                                          no VRChat window, or it is minimized or all black
// The signature is the picture's brightness in a 16×16 grid, as hex: what the next call is given as `--last`.
#include <windows.h>
#include <wincodec.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cwchar>
#include <string>
#include <vector>

namespace {

const int GRID = 16;
/** Mean difference of the grid's cells, of 255, under which two pictures are the same view. */
const int SAME_BELOW = 3;
/** A grid no brighter than this anywhere is a window that gave no picture. */
const int BLACK_BELOW = 8;

template <class T> struct Com {
    T* p = nullptr;
    ~Com() { if (p) p->Release(); }
    T** operator&() { return &p; }
    T* operator->() const { return p; }
};

bool endsWith(const std::wstring& text, const wchar_t* tail) {
    const size_t n = wcslen(tail);
    return text.size() >= n && _wcsicmp(text.c_str() + text.size() - n, tail) == 0;
}

BOOL CALLBACK find(HWND window, LPARAM found) {
    if (!IsWindowVisible(window) || GetWindow(window, GW_OWNER)) return TRUE;
    wchar_t name[64] = {};
    GetClassNameW(window, name, 64);
    if (wcscmp(name, L"UnityWndClass") != 0) return TRUE;
    DWORD pid = 0;
    GetWindowThreadProcessId(window, &pid);
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) return TRUE;
    wchar_t path[MAX_PATH] = {};
    DWORD size = MAX_PATH;
    const bool named = QueryFullProcessImageNameW(process, 0, path, &size) != 0;
    CloseHandle(process);
    if (!named || !endsWith(path, L"\\VRChat.exe")) return TRUE;
    *reinterpret_cast<HWND*>(found) = window;
    return FALSE;
}

int none() {
    puts("{\"state\":\"none\"}");
    return 0;
}

std::string hexOf(const std::vector<uint8_t>& cells) {
    static const char digits[] = "0123456789abcdef";
    std::string out;
    for (uint8_t cell : cells) { out += digits[cell >> 4]; out += digits[cell & 15]; }
    return out;
}

/** The picture's brightness, cell by cell: every fourth pixel is enough to tell one view from another. */
std::vector<uint8_t> signatureOf(const uint8_t* bgra, int width, int height) {
    std::vector<uint8_t> cells(GRID * GRID);
    for (int gy = 0; gy < GRID; gy++) {
        for (int gx = 0; gx < GRID; gx++) {
            uint64_t sum = 0, count = 0;
            for (int y = gy * height / GRID; y < (gy + 1) * height / GRID; y += 4) {
                const uint8_t* row = bgra + static_cast<size_t>(y) * width * 4;
                for (int x = gx * width / GRID; x < (gx + 1) * width / GRID; x += 4) {
                    sum += (row[x * 4] * 29 + row[x * 4 + 1] * 150 + row[x * 4 + 2] * 77) >> 8;
                    count++;
                }
            }
            cells[gy * GRID + gx] = static_cast<uint8_t>(count ? sum / count : 0);
        }
    }
    return cells;
}

bool sameView(const std::vector<uint8_t>& cells, const wchar_t* last) {
    if (!last || wcslen(last) != cells.size() * 2) return false;
    int64_t difference = 0;
    for (size_t i = 0; i < cells.size(); i++) {
        wchar_t pair[3] = { last[i * 2], last[i * 2 + 1], 0 };
        difference += std::abs(static_cast<int>(wcstol(pair, nullptr, 16)) - cells[i]);
    }
    return difference < static_cast<int64_t>(SAME_BELOW) * static_cast<int64_t>(cells.size());
}

bool writeJpeg(const wchar_t* file, uint8_t* bgra, int width, int height) {
    Com<IWICImagingFactory> factory;
    if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory)))) return false;
    Com<IWICBitmap> bitmap;
    if (FAILED(factory->CreateBitmapFromMemory(width, height, GUID_WICPixelFormat32bppBGR, width * 4, width * 4 * height, bgra, &bitmap))) return false;
    Com<IWICFormatConverter> plain;
    if (FAILED(factory->CreateFormatConverter(&plain))) return false;
    if (FAILED(plain->Initialize(bitmap.p, GUID_WICPixelFormat24bppBGR, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom))) return false;
    Com<IWICStream> stream;
    if (FAILED(factory->CreateStream(&stream)) || FAILED(stream->InitializeFromFilename(file, GENERIC_WRITE))) return false;
    Com<IWICBitmapEncoder> encoder;
    if (FAILED(factory->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, &encoder)) || FAILED(encoder->Initialize(stream.p, WICBitmapEncoderNoCache))) return false;
    Com<IWICBitmapFrameEncode> frame;
    Com<IPropertyBag2> options;
    if (FAILED(encoder->CreateNewFrame(&frame, &options))) return false;
    PROPBAG2 quality = {};
    wchar_t qualityName[] = L"ImageQuality";
    quality.pstrName = qualityName;
    VARIANT value;
    VariantInit(&value);
    value.vt = VT_R4;
    value.fltVal = 0.85f;
    options->Write(1, &quality, &value);
    if (FAILED(frame->Initialize(options.p)) || FAILED(frame->SetSize(width, height))) return false;
    WICPixelFormatGUID format = GUID_WICPixelFormat24bppBGR;
    if (FAILED(frame->SetPixelFormat(&format)) || FAILED(frame->WriteSource(plain.p, nullptr))) return false;
    return SUCCEEDED(frame->Commit()) && SUCCEEDED(encoder->Commit());
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
    if (argc < 2) return 2;
    const wchar_t* out = argv[1];
    const wchar_t* last = nullptr;
    for (int i = 2; i + 1 < argc; i++) if (wcscmp(argv[i], L"--last") == 0) last = argv[i + 1];

    // Real pixels, whatever the display's scale.
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    HWND window = nullptr;
    EnumWindows(find, reinterpret_cast<LPARAM>(&window));
    if (!window || IsIconic(window)) return none();
    RECT client = {};
    GetClientRect(window, &client);
    const int width = client.right, height = client.bottom;
    if (width < 320 || height < 240) return none();

    BITMAPINFO info = {};
    info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    info.bmiHeader.biWidth = width;
    info.bmiHeader.biHeight = -height;  // top-down
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB;
    void* bits = nullptr;
    HDC screen = GetDC(nullptr);
    HDC memory = CreateCompatibleDC(screen);
    HBITMAP section = CreateDIBSection(screen, &info, DIB_RGB_COLORS, &bits, nullptr, 0);
    ReleaseDC(nullptr, screen);
    if (!memory || !section || !bits) return 1;
    HGDIOBJ before = SelectObject(memory, section);
    // PW_RENDERFULLCONTENT (2): the picture the compositor holds, which a window drawn by the graphics card needs.
    const BOOL drawn = PrintWindow(window, memory, PW_CLIENTONLY | 2);
    GdiFlush();
    SelectObject(memory, before);
    DeleteDC(memory);
    if (!drawn) { DeleteObject(section); return 1; }

    uint8_t* bgra = static_cast<uint8_t*>(bits);
    const std::vector<uint8_t> cells = signatureOf(bgra, width, height);
    bool black = true;
    for (uint8_t cell : cells) if (cell >= BLACK_BELOW) { black = false; break; }
    if (black) { DeleteObject(section); return none(); }
    const std::string signature = hexOf(cells);
    if (sameView(cells, last)) {
        DeleteObject(section);
        printf("{\"state\":\"same\",\"signature\":\"%s\"}\n", signature.c_str());
        return 0;
    }

    if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) { DeleteObject(section); return 1; }
    // Written beside itself first: a picture half written is never one the folder holds.
    const std::wstring part = std::wstring(out) + L".part";
    const bool written = writeJpeg(part.c_str(), bgra, width, height);
    DeleteObject(section);
    CoUninitialize();
    if (!written || !MoveFileExW(part.c_str(), out, MOVEFILE_REPLACE_EXISTING)) {
        DeleteFileW(part.c_str());
        return 1;
    }
    printf("{\"state\":\"saved\",\"width\":%d,\"height\":%d,\"signature\":\"%s\"}\n", width, height, signature.c_str());
    return 0;
}
