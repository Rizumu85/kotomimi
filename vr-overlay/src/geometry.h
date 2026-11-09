// vr-overlay/src/geometry.h
//
// The helper's geometry, apart from OpenVR so it can be tested alone: where
// the wrist panel sits on a controller, when it faces the eyes, where the
// caption strip follows the view, and what the other hand's poke does.
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
 * The wrist panel in its controller's space. Holding the forearm across the
 * chest, back of the hand up: the panel lies on the back of the wrist facing
 * up, its top away from the body, its lines running toward the hand — a
 * watch. `turn` (degrees, yaw/pitch/roll in the panel's own space) and `at`
 * (metres, in the controller's space) tune it.
 */
Mat34 wristOffset(bool leftHand, Vec3 at, Vec3 turn);

/** Whether a panel at `panel` faces eyes at `hmd` closely enough to be shown; looser while already shown. */
bool facesEyes(const Mat34& panel, const Mat34& hmd, bool shown);

/**
 * Where a film's subtitles are: low in the view, out of the way of the world, a glance down away. 14° read as the
 * middle of a headset's view (a friend's test, 2026-11-08).
 */
struct StripConfig {
  float distance = 1.4f;       // metres from the eyes
  float below = 22.0f;         // degrees under the line of sight
  float yawSlack = 8.0f;       // degrees the head may turn before the strip follows: it stays in view through a fight
  float pitchSlack = 25.0f;    // a glance down at a watch does not drag it along
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

/** The other hand pressing the panel: where its tip is on it, and whether it is pressed. */
struct PokeConfig {
  float hoverDepth = 0.08f;    // metres in front of the panel where the tip is shown
  float pressDepth = 0.004f;   // a tip this near (or through) presses
  float releaseDepth = 0.02f;  // and releases once back this far
  float margin = 0.01f;        // metres beyond the edges still counted as on it
};

enum class PokeEvent { None, Hover, Down, Up, Leave };

struct Poke {
  bool hovering = false;
  bool down = false;
  float u = 0, v = 0;          // 0..1 from the panel's top left
};

/** `tipInPanel` is the tip in the panel's own space (metres; +Z out of its face); `w`, `h` the panel's size. */
PokeEvent updatePoke(Poke& p, Vec3 tipInPanel, float w, float h, const PokeConfig& c);
