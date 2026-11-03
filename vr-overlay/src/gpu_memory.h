// vr-overlay/src/gpu_memory.h
//
// How much of the graphics card's own memory is in use, by every process:
// Windows' "GPU Adapter Memory" counters, for the card with the most memory.
#pragma once

#include <cstdint>

struct GpuMemory {
  bool ok = false;
  uint64_t used = 0;
  uint64_t total = 0;
};

class GpuMemoryReader {
 public:
  ~GpuMemoryReader();
  GpuMemory read();

 private:
  bool open();
  void* query_ = nullptr;
  void* counter_ = nullptr;
  wchar_t luid_[40] = {};
  uint64_t total_ = 0;
  bool tried_ = false;
};
