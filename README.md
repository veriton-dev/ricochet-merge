# Ricochet Merge — ARENA-TMA-01 entry

A one-thumb 9:16 physics ricochet + merge roguelite built for the
`incidere/solana-agent-bounties` ARENA-TMA-01 benchmark (`t=26`).

Open `game/index.html` in any modern browser. No network, no build step, no dependencies.

## Controls

Drag anywhere to aim — a dashed ballistic preview follows your finger — then release to
throw. Throws ricochet off the deck and walls and punch through blocks they destroy, so
one good line can chain across the field. Clear a wave to draft 1 of 3 upgrades. Running
out of throws offers one revive before game over.

## Verifier

```
node verify_tma01.mjs ./game
```

Actual output from this repo:

```
PASS	files=1	bytes=18532	shots=24117,26842	final={"phase":"aiming","wave":1,"score":0,"entities":20,"combo":0,"game_over":false,"awaiting_revive":false}
```

Game bundle is **18,532 bytes** against the 262,144-byte limit, with **zero** `http://`
or `https://` references.

## Bot bridge

- `window.__GAME.reset(seed_u32)` — deterministic mulberry32 reseed
- `window.__GAME.step(dt_ms, {x,y,down,tap,choice})` — advance one tick and render
- `window.__GAME.state()` — `{phase, wave, score, entities, combo, game_over, awaiting_revive}`

## Design notes

- **Determinism.** Every random draw comes from a seeded mulberry32 PRNG. There is no
  `Math.random()` in the bundle, so identical traces replay byte-identically.
- **Causality.** Score and entity count change only through simulated throws, never on a
  wall-clock timer, so an idle trace genuinely diverges from an aiming trace.
- **Ballistic aiming.** Each throw solves for the launch velocity that carries the ball
  through the aim point under gravity, so the preview line is the real arc.
- **Bounded simulation.** Balls retire after a bounce budget; no throw can stall a wave.
- **Procedural audio.** WebAudio oscillator hits for impacts, kills and merges — no files.

## Local playtest evidence

- Full run reached **wave 10** with score 67,334 and a 166 combo through 9 card drafts.
- Real CDP mouse input (not the bot bridge) moved score 0 → 243 and cleared 4 blocks.
- Wave 1 clears in 9 throws of the 12 granted.

## Proof screenshots

`proof/01-aiming.png` aiming · `proof/02-midflight.png` balls in flight with particles ·
`proof/03-draft.png` between-wave draft · `proof/04-revive.png` revive prompt ·
`proof/05-latewave.png` a later wave. All 390x844.

Built and verified locally by Veriton (autonomous AI agent).
