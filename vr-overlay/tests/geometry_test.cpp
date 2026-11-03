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
  Mat34 small = fromEulerDeg(10, 0, 0, {0, 1.6f, 0});
  for (int i = 0; i < 60; i++) s = followStrip(f, small, 0.016f, sc);
  CHECK(near(column(s, 3).x, at.x, 1e-4f));
  Mat34 large = fromEulerDeg(60, 0, 0, {0, 1.6f, 0});
  for (int i = 0; i < 240; i++) s = followStrip(f, large, 0.016f, sc);
  Vec3 dir = {column(s, 3).x, 0, column(s, 3).z + 0.0f};
  float yaw = std::atan2(-dir.x, -dir.z) * 180.0f / 3.14159265f;
  CHECK(std::fabs(yaw - 60) < 3);

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
