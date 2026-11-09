// vr-overlay/src/geometry.h
//
// The helper's geometry, apart from OpenVR so it can be tested alone: where
// the caption strip follows the view.
#pragma once

struct Vec3 { float x, y, z; };

/** Rows of a rigid transform, the last column the translation: vr::HmdMatrix34_t's layout. */
struct Mat34 { float m[3][4]; };

Mat34 identity();
Mat34 mul(const Mat34& a, const Mat34& b);
/** The inverse of a rotation plus a translation. */
Mat34 inverseRigid(const Mat34& a);
Vec3 apply(const Mat34& a, Vec3 p);
Vec3 column(const Mat34& a, int c);
/** Yaw about Y, then pitch about X, then roll about Z, in degrees, at `t`. */
Mat34 fromEulerDeg(float yaw, float pitch, float roll, Vec3 t);

/**
 * Where a film's subtitles are: low in the view, out of the way of the world, a glance down away. 14° read as the
 * middle of a headset's view (a friend's test, 2026-11-08).
 */
struct StripConfig {
  float distance = 1.4f;       // metres from the eyes
  float below = 22.0f;         // degrees under the line of sight
  float yawSlack = 8.0f;       // degrees the head may turn before the strip follows: it stays in view through a fight
  float pitchSlack = 25.0f;    // a glance down at a watch does not drag it along
  float levelBand = 10.0f;     // the head this near level: the strip goes back to its height under the horizon
  float rate = 5.0f;           // how fast it catches up, per second
};

/** Where the strip is: it stays put while the head turns a little, then glides back under the line of sight. */
struct LazyFollow {
  bool placed = false;
  bool turning = false;        // catching up with the head's turn
  bool tilting = false;        // and with its tilt, apart
  float yaw = 0, pitch = 0;    // radians
};

Mat34 followStrip(LazyFollow& f, const Mat34& hmd, float dt, const StripConfig& c);

