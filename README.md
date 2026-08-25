# MyVeryOwnHostinBot v15

## Movement rewrite

- Pathfinder is the only navigation controller.
- No forced `forward`, `back`, `left`, `right`, or `jump` movement for normal navigation.
- `allowFreeMotion` is disabled.
- Conservative pathfinding profile: digging enabled, liquid expensive, max drop 1 block.
- A local safe-target selector gives the bot a real destination when idle.
- Stuck recovery clears controls and asks Pathfinder for a new local route.
- Random jump, circle walk and look-around are disabled.

## Combat

- Hostile mobs only. Players are never combat targets.
- Combat movement uses Pathfinder instead of direct strafe/back control.
- Low-health retreat uses Pathfinder.
- Auto-eat and weapon selection remain local.

## Mining

- Existing mining and gathering modules are retained.
- Ore search, branch mining, lava avoidance, torches and tool handling remain enabled.

## AI independence

- No OpenAI API, API key, GPT endpoint or external LLM is required.
- Decision making uses local code, Minecraft state, recipes, memory and experience.
- External knowledge/video research is disabled by default.

## Validation

- Every JavaScript file checked with `node --check`.
- `settings.json` parsed with Python JSON parser.
- No OpenAI/API-key references found in project source.
- Live Minecraft server testing was not possible in this environment.
