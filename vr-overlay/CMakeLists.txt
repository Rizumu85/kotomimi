cmake_minimum_required(VERSION 3.20)
project(kotomimi_vr_overlay CXX)

# Fork: the SteamVR overlay helper (vr-overlay/src/main.cpp). The OpenVR SDK is
# fetched, pinned, by `node vr-overlay/fetch-openvr.mjs` into third_party/.
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")

set(OPENVR_DIR ${CMAKE_CURRENT_SOURCE_DIR}/third_party/openvr)
if(NOT EXISTS ${OPENVR_DIR}/openvr.h)
  message(FATAL_ERROR "OpenVR SDK missing: run `node vr-overlay/fetch-openvr.mjs` first")
endif()

add_executable(kotomimi-vr src/main.cpp src/geometry.cpp src/gpu_memory.cpp)
target_include_directories(kotomimi-vr PRIVATE ${OPENVR_DIR} src)
target_link_libraries(kotomimi-vr PRIVATE ${OPENVR_DIR}/openvr_api.lib d3d11 dxgi pdh)
target_compile_definitions(kotomimi-vr PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX UNICODE _UNICODE)
add_executable(geometry-test tests/geometry_test.cpp src/geometry.cpp)
target_include_directories(geometry-test PRIVATE ${OPENVR_DIR} src)
if(MSVC)
  target_compile_options(kotomimi-vr PRIVATE /W4 /utf-8)
  target_compile_options(geometry-test PRIVATE /W4 /utf-8)
endif()
# Beside the helper, its one library; and all three in kotomimi-vr/, which the app's package takes (forge.config.js).
set(SHIPPED ${CMAKE_CURRENT_SOURCE_DIR}/kotomimi-vr)
add_custom_command(TARGET kotomimi-vr POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different ${OPENVR_DIR}/openvr_api.dll $<TARGET_FILE_DIR:kotomimi-vr>
  COMMAND ${CMAKE_COMMAND} -E make_directory ${SHIPPED}
  COMMAND ${CMAKE_COMMAND} -E copy_if_different $<TARGET_FILE:kotomimi-vr> ${OPENVR_DIR}/openvr_api.dll ${SHIPPED}
  COMMAND ${CMAKE_COMMAND} -E copy_if_different ${OPENVR_DIR}/LICENSE ${SHIPPED}/OPENVR-LICENSE.txt)

