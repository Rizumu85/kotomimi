// vr-overlay/src/gpu_memory.cpp
#include "gpu_memory.h"

#include <windows.h>
#include <dxgi.h>
#include <pdh.h>
#include <pdhmsg.h>

#include <cstdio>
#include <cwchar>
#include <vector>

GpuMemoryReader::~GpuMemoryReader() {
  if (query_) PdhCloseQuery(static_cast<PDH_HQUERY>(query_));
}

bool GpuMemoryReader::open() {
  tried_ = true;
  IDXGIFactory1* factory = nullptr;
  if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(&factory)))) return false;
  DXGI_ADAPTER_DESC1 best{};
  IDXGIAdapter1* adapter = nullptr;
  for (UINT i = 0; factory->EnumAdapters1(i, &adapter) != DXGI_ERROR_NOT_FOUND; i++) {
    DXGI_ADAPTER_DESC1 desc{};
    adapter->GetDesc1(&desc);
    adapter->Release();
    // Virtual displays (streaming, remote desktop) report no memory of their own.
    if (!(desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) && desc.DedicatedVideoMemory > best.DedicatedVideoMemory) best = desc;
  }
  factory->Release();
  if (best.DedicatedVideoMemory == 0) return false;
  total_ = best.DedicatedVideoMemory;
  swprintf(luid_, 40, L"luid_0x%08X_0x%08X", static_cast<unsigned>(best.AdapterLuid.HighPart), static_cast<unsigned>(best.AdapterLuid.LowPart));

  PDH_HQUERY query = nullptr;
  if (PdhOpenQueryW(nullptr, 0, &query) != ERROR_SUCCESS) return false;
  PDH_HCOUNTER counter = nullptr;
  if (PdhAddEnglishCounterW(query, L"\\GPU Adapter Memory(*)\\Dedicated Usage", 0, &counter) != ERROR_SUCCESS) {
    PdhCloseQuery(query);
    return false;
  }
  query_ = query;
  counter_ = counter;
  return true;
}

GpuMemory GpuMemoryReader::read() {
  GpuMemory out;
  if (!tried_ && !open()) return out;
  if (!query_) return out;
  if (PdhCollectQueryData(static_cast<PDH_HQUERY>(query_)) != ERROR_SUCCESS) return out;
  DWORD size = 0, count = 0;
  PDH_STATUS status = PdhGetFormattedCounterArrayW(static_cast<PDH_HCOUNTER>(counter_), PDH_FMT_LARGE, &size, &count, nullptr);
  if (status != PDH_MORE_DATA) return out;
  std::vector<unsigned char> buffer(size);
  auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(buffer.data());
  if (PdhGetFormattedCounterArrayW(static_cast<PDH_HCOUNTER>(counter_), PDH_FMT_LARGE, &size, &count, items) != ERROR_SUCCESS) return out;
  uint64_t used = 0;
  bool found = false;
  for (DWORD i = 0; i < count; i++) {
    if (wcsstr(items[i].szName, luid_) && items[i].FmtValue.CStatus == PDH_CSTATUS_VALID_DATA) {
      used += static_cast<uint64_t>(items[i].FmtValue.largeValue);
      found = true;
    }
  }
  if (!found) return out;
  out.ok = true;
  out.used = used;
  out.total = total_;
  return out;
}
