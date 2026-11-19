@AGENTS.md

## Claude Code specifics

- `PLAN.md` is the plan. When you finish a task from its schedule or cut something from the cut list, add one line to the "Progress log" at the bottom of `PLAN.md` with the time (CST) and what changed.
- Before building or restyling `web/`, load the `website-design` skill.
- Before writing the README, the Devpost answers or pitch notes, load the `humanize-write` skill.
- Before making the demo video, load the `demo-video` skill. It takes well over 10 minutes, so start by T-4h.
- Use subagents only when a person asks for them. Two people are each running their own sessions, so work in your owner's directories (see Ownership in AGENTS.md).
- When something in "Open items to verify at H0" in `PLAN.md` gets confirmed, write the confirmed value into `deployments/arc-testnet.json` or `spec/instances.md` and tick it off in `PLAN.md`.
- If a real-system step fails during a demo rehearsal, fix the cause. Never add a fallback that fakes the result (see "No hardcoding").
