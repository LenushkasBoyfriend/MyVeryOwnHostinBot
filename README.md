# MyVeryOwnHostinBot v15.3

Movement and survival loop rewrite.

- Pathfinder is the only normal movement owner.
- No random idle wandering.
- Jump assist only when a real 1-block obstacle is directly ahead and the next two spaces are clear.
- Stuck recovery uses a tiny local goal instead of forced forward/jump.
- Survival priorities are deterministic: wood -> tools -> food -> fuel/iron/mining.
- No OpenAI/API dependency.
- Chat spam disabled by default.
- Combat targets only hostile mobs.
