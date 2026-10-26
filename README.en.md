# Wish Specializer

**v0.9.0-stable** · DSH Web plugin · package `@dsh-external/dsh-wish-specializer`

[中文](README.md) ｜ **English**

> Turns a one-line wish into requirements the working AI can actually follow.

---

## What it is

The parts that decide
whether the result is good — **aesthetic register, light and material, composition and depth, setting,
interaction and states, and what counts as done** — are filled in **before you hit send**, then handed to
the working AI together with your words.

In one sentence: **your words stay untouched; the missing half is supplied.**

## What it is not

- It **never rewrites** your request — no trimming, narrowing, or "improving" your intent;
- It **never decides for you**: architecture forks that change the shape of the deliverable stay yours;
- It **never records "accepted"**: the advisor only contributes directions and reviews;
- It is **not on npm** (`private: true`); it ships as a GitHub Release asset;
- It **does not touch the host**: no DSH UI files, no custom session event types.

## Side by side

Windows + DSH + PTC preset, one shot, tier "Heavy", model DeepSeek-V4.1-Flash-0910.

![](./docs/image/contrast_small.png)

Prompt (verbatim):

> Do not preview other files in the folder; build a single-HTML program: an extremely detailed modern main battle tank model, previewable, controllable, realistic, good-looking, showy-photographic.

## What it adds

| Dimension | What gets filled in |
|---|---|
| Aesthetic register | Cold and hard vs. warm, realistic vs. stylized |
| Light and material | Key light, contrast, reflectivity/roughness, worn vs. pristine |
| Composition and depth | Subject scale, foreground/mid/back separation, visual focus |
| Setting and mood | Ambient light, atmosphere, ground and background |
| Interaction and states | What can be operated, hover/click/drag feedback, boundaries |
| Acceptance | One line that says what "done" means, so you stop ping-ponging |

Additions are **directional requirements** — no code, no numeric parameters, no implementation steps.

## Use it in 30 seconds

1. Install (below) and set the **tier** to "Standard" or "Heavy" ("Off" neither intercepts nor injects);
2. Type as usual and press **Enter**;
3. In the intercept panel, click "Confirm", or "Skip and send as-is";
4. Want speed? **Press Enter twice** to skip this round (on by default, two presses within 600 ms);
5. After sending, the "Injected" card under the message shows exactly what went into the context.

## Tiers

| Tier | Additions | Packet budget | Clarifying questions |
|---|---|---|---|
| Off | record only | — | — |
| Light | 2–3 decisive directions | 700 chars | 1 |
| Standard | 4–6 items + acceptance line | 1200 chars | 2 |
| Heavy | the decisive few, written through + staging note | 2000 chars | 3 |

Tiers widen "how much / how many questions", **never your decision rights**.

## Also in the panel

- **Advisor**: a separate read-only model reviews the round and returns executable directions;
- **Permission**: Review (show sources first) / Auto;
- **English mode**: additionally return a faithful English task;
- **Model and thinking effort** for the explainer;
- **Context**: last N turns, or everything you still hold;
- **Read-only tools / built-in Bash**: let it look at a few project files first;
- **Double-Enter skip**: on by default;
- **Details**: the control and explainer prompts, visible and editable.

## Install

The only source is the **Release asset** (`.tgz`) in this repository.

```powershell
$v = '0.9.0-stable'; $d = "$env:USERPROFILE\Downloads"
Invoke-WebRequest "https://github.com/WestFox-AwA/dsh-wish-specializer/releases/download/v$v/dsh-external-dsh-wish-specializer-$v.tgz" -OutFile "$d\dsh-external-dsh-wish-specializer-$v.tgz"
Invoke-WebRequest "https://github.com/WestFox-AwA/dsh-wish-specializer/releases/download/v$v/SHA256SUMS-$v.txt" -OutFile "$d\SHA256SUMS-$v.txt"
Get-Content "$d\SHA256SUMS-$v.txt"     # compare sha256 with the tgz you downloaded
dsh --profile po061 --from-default-profile web --dump-config
dsh plugin --profile po061 add "$d\dsh-external-dsh-wish-specializer-$v.tgz"
dsh --profile po061
```

- Not on npm: `private: true`; any same-named package in a registry is not this project;
- Do not install into the profile that hosts 0.5.x — the `DOUBLE_INTERCEPT` guard refuses it (by design);
- Install troubleshooting and a four-step self-check: [`po06/README.md`](po06/README.md).

## Docs

| Looking for | Where |
|---|---|
| Help text (same source as the panel's `?`) | [`po06/HELP-0.6.en.md`](po06/HELP-0.6.en.md) |
| Install / self-check / troubleshooting | [`po06/README.md`](po06/README.md) |
| Changelog | [`CHANGELOG.md`](CHANGELOG.md) |
| Historical acceptance checklist | [Legacy checklist](docs/legacy/po06-HUMAN-TEST.md) (not current acceptance) |
| Release procedure | [`docs/RELEASING.md`](docs/RELEASING.md) |
| Legacy versions (0.1–0.6) | [`old/`](old/README.md) |

## Version and evidence

- Current: **v0.9.0-stable**; previous stable: v0.8.4-stable
- All suites: `node po06/scripts/run-suites.mjs`; release gate: `node po06/scripts/check-release.mjs`
- Compatibility: `dsh-0.1.7-rc.2` (run for real), `dsh-0.2.0-rc.2` (static contract check)
- Author: 啃轮胎的西狐 · QQ group **1121399051** (announcements / install help)

## License

[BSD-3-Clause](LICENSE) · fully open source.
