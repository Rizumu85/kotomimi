// vr-overlay/src/geometry.cpp
#include "geometry.h"

#include <algorithm>
#include <cmath>

namespace {
constexpr float kDeg = 3.14159265358979f / 180.0f;

Vec3 sub(Vec3 a, Vec3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
float dot(Vec3 a, Vec3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
Vec3 cross(Vec3 a, Vec3 b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
float length(Vec3 a) { return std::sqrt(dot(a, a)); }
Vec3 normalize(Vec3 a) {
  float l = length(a);
  return l > 1e-6f ? Vec3{a.x / l, a.y / l, a.z / l} : Vec3{0, 0, 0};
}
float wrapAngle(float a) {
  while (a > 3.14159265f) a -= 6.2831853f;
  while (a < -3.14159265f) a += 6.2831853f;
  return a;
}
Mat34 fromAxes(Vec3 x, Vec3 y, Vec3 z, Vec3 t) {
  return {{{x.x, y.x, z.x, t.x}, {x.y, y.y, z.y, t.y}, {x.z, y.z, z.z, t.z}}};
}
}  // namespace

Mat34 identity() { return {{{1, 0, 0, 0}, {0, 1, 0, 0}, {0, 0, 1, 0}}}; }

Mat34 mul(const Mat34& a, const Mat34& b) {
  Mat34 r{};
  for (int i = 0; i < 3; i++) {
    for (int j = 0; j < 4; j++) {
      r.m[i][j] = a.m[i][0] * b.m[0][j] + a.m[i][1] * b.m[1][j] + a.m[i][2] * b.m[2][j] + (j == 3 ? a.m[i][3] : 0.0f);
    }
  }
  return r;
}

Mat34 inverseRigid(const Mat34& a) {
  Mat34 r{};
  for (int i = 0; i < 3; i++)
    for (int j = 0; j < 3; j++) r.m[i][j] = a.m[j][i];
  for (int i = 0; i < 3; i++) r.m[i][3] = -(r.m[i][0] * a.m[0][3] + r.m[i][1] * a.m[1][3] + r.m[i][2] * a.m[2][3]);
  return r;
}

Vec3 apply(const Mat34& a, Vec3 p) {
  return {a.m[0][0] * p.x + a.m[0][1] * p.y + a.m[0][2] * p.z + a.m[0][3],
          a.m[1][0] * p.x + a.m[1][1] * p.y + a.m[1][2] * p.z + a.m[1][3],
          a.m[2][0] * p.x + a.m[2][1] * p.y + a.m[2][2] * p.z + a.m[2][3]};
}

Vec3 column(const Mat34& a, int c) { return {a.m[0][c], a.m[1][c], a.m[2][c]}; }

Mat34 fromEulerDeg(float yaw, float pitch, float roll, Vec3 t) {
  float cy = std::cos(yaw * kDeg), sy = std::sin(yaw * kDeg);
  float cp = std::cos(pitch * kDeg), sp = std::sin(pitch * kDeg);
  float cr = std::cos(roll * kDeg), sr = std::sin(roll * kDeg);
  Mat34 ry = {{{cy, 0, sy, 0}, {0, 1, 0, 0}, {-sy, 0, cy, 0}}};
  Mat34 rx = {{{1, 0, 0, 0}, {0, cp, -sp, 0}, {0, sp, cp, 0}}};
  Mat34 rz = {{{cr, -sr, 0, 0}, {sr, cr, 0, 0}, {0, 0, 1, 0}}};
  Mat34 r = mul(mul(ry, rx), rz);
  r.m[0][3] = t.x;
  r.m[1][3] = t.y;
  r.m[2][3] = t.z;
  return r;
}

Mat34 wristOffset(bool leftHand, Vec3 at, Vec3 turn) {
  // The controller's -Z runs along the fingers and +Y out of the back of the hand. The panel faces +Y; on the left
  // hand, held across the chest, the body is toward the controller's +X, so the panel's top is -X; mirrored on the right.
  Mat34 base = leftHand ? fromAxes({0, 0, -1}, {-1, 0, 0}, {0, 1, 0}, at) : fromAxes({0, 0, 1}, {1, 0, 0}, {0, 1, 0}, at);
  return mul(base, fromEulerDeg(turn.x, turn.y, turn.z, {0, 0, 0}));
}

bool facesEyes(const Mat34& panel, const Mat34& hmd, bool shown) {
  Vec3 centre = column(panel, 3);
  Vec3 eyes = column(hmd, 3);
  Vec3 toEyes = sub(eyes, centre);
  float distance = length(toEyes);
  if (distance > (shown ? 0.9f : 0.75f) || distance < 0.05f) return false;
  toEyes = normalize(toEyes);
  // The panel's face toward the eyes, and the eyes toward the panel: both, so it shows only when looked at.
  float facing = dot(normalize(column(panel, 2)), toEyes);
  Vec3 gaze = normalize(Vec3{-hmd.m[0][2], -hmd.m[1][2], -hmd.m[2][2]});
  float looking = dot(gaze, Vec3{-toEyes.x, -toEyes.y, -toEyes.z});
  float faceMin = std::cos((shown ? 65.0f : 50.0f) * kDeg);
  float lookMin = std::cos((shown ? 50.0f : 38.0f) * kDeg);
  return facing > faceMin && looking > lookMin;
}

Mat34 followStrip(LazyFollow& f, const Mat34& hmd, float dt, const StripConfig& c) {
  Vec3 gaze = normalize(Vec3{-hmd.m[0][2], -hmd.m[1][2], -hmd.m[2][2]});
  float headYaw = std::atan2(-gaze.x, -gaze.z);
  float headPitch = std::asin(std::clamp(gaze.y, -1.0f, 1.0f));
  float wantYaw = headYaw;
  float wantPitch = std::clamp(headPitch - c.below * kDeg, -60.0f * kDeg, 25.0f * kDeg);
  if (!f.placed) {
    f.placed = true;
    f.yaw = wantYaw;
    f.pitch = wantPitch;
  }
  float dy = wrapAngle(wantYaw - f.yaw);
  float dp = wantPitch - f.pitch;
  // A turn and a tilt are followed apart: turning while looking down at a watch does not bring the strip down to it.
  if (std::fabs(dy) > c.yawSlack * kDeg) f.turning = true;
  if (std::fabs(dp) > c.pitchSlack * kDeg) f.tilting = true;
  // Eased by the time passed, not the frames: the same glide at 72 Hz and 144.
  float k = 1.0f - std::exp(-dt * c.rate);
  if (f.turning) {
    f.yaw = wrapAngle(f.yaw + dy * k);
    if (std::fabs(dy) < 1.0f * kDeg) f.turning = false;
  }
  if (f.tilting) {
    f.pitch += dp * k;
    if (std::fabs(dp) < 1.0f * kDeg) f.tilting = false;
  }
  Vec3 dir = {-std::sin(f.yaw) * std::cos(f.pitch), std::sin(f.pitch), -std::cos(f.yaw) * std::cos(f.pitch)};
  Vec3 eyes = column(hmd, 3);
  Vec3 at = {eyes.x + dir.x * c.distance, eyes.y + dir.y * c.distance, eyes.z + dir.z * c.distance};
  Vec3 z = {-dir.x, -dir.y, -dir.z};
  Vec3 x = normalize(cross({0, 1, 0}, z));
  Vec3 y = cross(z, x);
  return fromAxes(x, y, z, at);
}

PokeEvent updatePoke(Poke& p, Vec3 tip, float w, float h, const PokeConfig& c) {
  bool over = tip.x > -w / 2 - c.margin && tip.x < w / 2 + c.margin && tip.y > -h / 2 - c.margin && tip.y < h / 2 + c.margin;
  bool inReach = over && tip.z < c.hoverDepth && tip.z > -0.05f;
  if (inReach) {
    p.u = std::clamp((tip.x + w / 2) / w, 0.0f, 1.0f);
    p.v = std::clamp((h / 2 - tip.y) / h, 0.0f, 1.0f);
  }
  if (p.down) {
    // Pressed: released by drawing back, or by leaving the panel (still released, so a press never sticks).
    if (!inReach || tip.z > c.releaseDepth) {
      p.down = false;
      p.hovering = inReach;
      return PokeEvent::Up;
    }
    return PokeEvent::None;
  }
  if (!inReach) {
    if (p.hovering) {
      p.hovering = false;
      return PokeEvent::Leave;
    }
    return PokeEvent::None;
  }
  p.hovering = true;
  if (tip.z < c.pressDepth) {
    p.down = true;
    return PokeEvent::Down;
  }
  return PokeEvent::Hover;
}
