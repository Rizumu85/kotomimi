// vr-overlay/tests/geometry_test.cpp — `geometry-test` exits non-zero on the first failure.
#include <cmath>
#include <cstdio>
#include <cstdlib>

#include "geometry.h"

static int failures = 0;
#define CHECK(cond)                                              \
  do {                                                           \
    if (!(cond)) {                                               \
      std::printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #cond); \
      failures++;                                                \
    }                                                            \
  } while (0)

static bool near(float a, float b, float eps = 1e-3f) { return std::fabs(a - b) < eps; }

int main() {
  // Rigid inverse undoes the transform.
  Mat34 m = fromEulerDeg(30, -20, 10, {0.1f, 1.5f, -0.3f});
  Vec3 p = apply(inverseRigid(m), apply(m, {0.2f, -0.4f, 0.7f}));
  CHECK(near(p.x, 0.2f) && near(p.y, -0.4f) && near(p.z, 0.7f));

  // Left forearm across the chest, pointing right (+X world), back of the hand up: the controller's -Z is +X, its +Y up,
  // so its +X is +Z (toward the body). The wrist panel faces up, its top away from the body (-Z), its lines toward the hand.
  Mat34 controller = {{{0, 0, -1, 0}, {0, 1, 0, 1.2f}, {1, 0, 0, -0.3f}}};
  Mat34 panel = mul(controller, wristOffset(true, {0, 0, 0}, {0, 0, 0}));
  Vec3 face = column(panel, 2), top = column(panel, 1), lines = column(panel, 0);
  CHECK(near(face.y, 1));
  CHECK(near(top.z, -1));
  CHECK(near(lines.x, 1));

  // Eyes above and behind the wrist, looking down at it: shown. Looking away: not.
  Mat34 lookingDown = fromEulerDeg(0, -60, 0, {0, 1.6f, 0.0f});
  // A panel facing up: pitch -90 turns its +Z to +Y.
  Mat34 atWrist = fromEulerDeg(0, -90, 0, {0, 1.2f, -0.25f});
  CHECK(column(atWrist, 2).y > 0.99f);
  CHECK(facesEyes(atWrist, lookingDown, false));
  Mat34 lookingAhead = fromEulerDeg(0, 0, 0, {0, 1.6f, 0.0f});
  CHECK(!facesEyes(atWrist, lookingAhead, false));
  Mat34 lookingBehind = fromEulerDeg(180, -60, 0, {0, 1.6f, 0.0f});
  CHECK(!facesEyes(atWrist, lookingBehind, true));

  // The strip: below the line of sight, facing the eyes; it stays for a small turn and follows a large one.
  StripConfig sc;
  LazyFollow f;
  Mat34 head = fromEulerDeg(0, 0, 0, {0, 1.6f, 0});
  Mat34 s = followStrip(f, head, 0.016f, sc);
  Vec3 at = column(s, 3);
  CHECK(at.z < -1.2f && at.y < 1.6f);
  CHECK(column(s, 2).z > 0.9f);
  // Low, as a film's subtitles: its centre some 22° under the line of sight.
  float below = std::atan2(1.6f - at.y, -at.z) * 180.0f / 3.14159265f;
  CHECK(std::fabs(below - sc.below) < 0.5f);
  auto yawOf = [](const Mat34& m) { Vec3 p = column(m, 3); return std::atan2(-p.x, -p.z) * 180.0f / 3.14159265f; };
  auto pitchOf = [](const Mat34& m) { Vec3 p = column(m, 3); return std::atan2(p.y - 1.6f, std::sqrt(p.x * p.x + p.z * p.z)) * 180.0f / 3.14159265f; };
  Mat34 small = fromEulerDeg(5, 0, 0, {0, 1.6f, 0});
  for (int i = 0; i < 60; i++) s = followStrip(f, small, 0.016f, sc);
  CHECK(near(column(s, 3).x, at.x, 1e-4f));
  // A turn past the slack: it follows within half a second, and settles under the line of sight.
  Mat34 large = fromEulerDeg(60, 0, 0, {0, 1.6f, 0});
  for (int i = 0; i < 30; i++) s = followStrip(f, large, 0.016f, sc);
  CHECK(yawOf(s) > 45);
  for (int i = 0; i < 210; i++) s = followStrip(f, large, 0.016f, sc);
  CHECK(std::fabs(yawOf(s) - 60) < 1.5f);
  // The same glide at 144 Hz as at 72.
  LazyFollow slow, fast;
  followStrip(slow, head, 0.016f, sc);
  followStrip(fast, head, 0.016f, sc);
  Mat34 a = head, b = head;
  for (int i = 0; i < 18; i++) a = followStrip(slow, large, 1.0f / 72, sc);
  for (int i = 0; i < 36; i++) b = followStrip(fast, large, 1.0f / 144, sc);
  CHECK(std::fabs(yawOf(a) - yawOf(b)) < 0.5f);
  // A glance down at the watch, turning a little on the way: the strip turns, and stays up.
  LazyFollow g;
  followStrip(g, head, 0.016f, sc);
  Mat34 watch = fromEulerDeg(15, -20, 0, {0, 1.6f, 0});
  for (int i = 0; i < 120; i++) s = followStrip(g, watch, 0.016f, sc);
  CHECK(std::fabs(yawOf(s) - 15) < 1.5f);
  CHECK(std::fabs(pitchOf(s) + sc.below) < 0.5f);

  // A poke: hover in front, press on the face, release on drawing back; leaving releases a press.
  PokeConfig pc;
  Poke k;
  CHECK(updatePoke(k, {0, 0, 0.2f}, 0.13f, 0.18f, pc) == PokeEvent::None);
  CHECK(updatePoke(k, {0.0325f, 0.045f, 0.05f}, 0.13f, 0.18f, pc) == PokeEvent::Hover);
  CHECK(near(k.u, 0.75f) && near(k.v, 0.25f));
  CHECK(updatePoke(k, {0.0325f, 0.045f, 0.002f}, 0.13f, 0.18f, pc) == PokeEvent::Down);
  CHECK(updatePoke(k, {0.0325f, 0.045f, -0.01f}, 0.13f, 0.18f, pc) == PokeEvent::None);
  CHECK(updatePoke(k, {0.0325f, 0.045f, 0.03f}, 0.13f, 0.18f, pc) == PokeEvent::Up);
  CHECK(updatePoke(k, {0.0325f, 0.045f, 0.0f}, 0.13f, 0.18f, pc) == PokeEvent::Down);
  CHECK(updatePoke(k, {0.5f, 0.045f, 0.0f}, 0.13f, 0.18f, pc) == PokeEvent::Up);
  CHECK(updatePoke(k, {0.5f, 0.045f, 0.0f}, 0.13f, 0.18f, pc) == PokeEvent::None);

  if (failures == 0) std::printf("geometry: all passed\n");
  return failures == 0 ? 0 : 1;
}
