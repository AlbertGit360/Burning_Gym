# World and character guidance

Choose world assets, art style, palette, camera and rendering approach to fit
the requested game. The SDK's scenery, world presets and `GameWorld` renderer
are optional building blocks. You can author your own world and assets while
using the SDK runtime and verified selected Friend. Custom character artwork,
animations, costumes and visual effects are also welcome.

The **576 × 384 plane belongs to the optional renderer**. Custom cameras and
worlds of any size are allowed. **960 × 640 is the reference viewport**, not a
required layout or world boundary. Portrait, wider and responsive layouts are
welcome, and scrolling maps and connected rooms can extend beyond the viewport.
Choose sizes that perform well on your target devices. The
[scrolling-world example](examples/scrolling-world) demonstrates a larger map.

## Choose the game's interface

Unless otherwise requested, deliver only the game component in the user's current
project. Use the interface that fits the idea: a walkable world, cards, a puzzle,
management screens or another format. The starter's vendors and opening stations
are examples. SDK menus are optional references; custom menus are welcome.
Keep the existing project structure and engine where practical and document the
SDK integration. Preserve the ownership requirement and sandbox boundary in
[AGENTS.md](AGENTS.md).

## Movement and interaction

Render game content and custom menus inside the sandbox, using a layout suited
to the game. Choose controls for its genre and target devices; games without
movement do not need walking controls. Keep controls readable and support loading,
errors and retry. Provide mute when using audio and reduced motion alternatives
for motion effects. When a game has movement, keep collision, pointer coordinates,
interaction reach and depth ordering consistent with its camera.

Pause game input when the runtime's `paused` prop is true. For movement-based
games, stop held movement on blur or hidden tabs and check the full movement path
against obstacles. Define travel between areas or across gaps as part of the game.

## Rare Friend character artwork

The SDK sprite reader provides canonical artwork as a starting point. You may
adapt or replace the visual representation, including recoloring, transforms,
custom animation, costumes, effects and a different art style. There is no
pixel-preservation requirement. Artwork does not prove ownership; the runtime
still verifies the connected account and selected Generations NFT separately.
See [artwork permissions](NOTICE.md) for use in previews and finished projects.

For projects choosing the canonical look, the supplied walking sprites are
16 × 16 one-bit masks. The reference renderer uses integer placement and scale,
a black mask and a white one-pixel halo. Native stills use 5× pixels in an 80 × 80
box with a horizontal-center / row-15 anchor. Genesis portraits are separate
8 × 8 artwork; Colossus has no up/down frames, so the supplied reader offers a
horizontal fallback. These describe the reference assets, not required styling.

## Optional SDK world renderer

`GameWorld`, `@rarefriends/friendsdk/world`, `navigation`, `movement` and
`loadWorldAssets` provide a ready-made implementation for the supplied world
format. The details below apply when using those utilities. A custom renderer
can use its own world format, camera and visual effects.

### Coordinates and projection

The supplied renderer uses a 576 × 384 ground plane and 1600 × 1200 native
exports, with this shallow projection:

```text
screenX = 800 + 1.5 × 0.8660254038 × (x - y - 96)
screenY = 690 + 1.5 × 0.28 × (x + y - 480) - lift
```

When using it, pair `project` with `unproject` for drawing and pointer input.
Crop or uniformly scale the composition to fit the game frame. A vertical lift
is a screen-space offset; inverse projection for walking assumes `lift = 0`.
Upright props and characters sort by their ground anchor's `x + y`.

### Presets and color options

Supplied presets contain editable off-chain scene data. The renderer provides
monochrome scenery with signal green `#CCFF00`, or its `GAME_PALETTE` through
`{ color: true }`. These are options for the supplied artwork; your game can
choose its own colors, textures, effects and world assets.

```js
import { getWorldPreset, renderWorld, renderProp } from '@rarefriends/friendsdk/world';

const world = getWorldPreset('01-garden-oval-complete');
const svg = renderWorld(world, { color: true });
const tree = renderProp('tree', { color: true });
```

### Geometry and loading variants

The SDK world format describes ground polygons, holes, paths, prop footprints
and blocked areas. Its navigation utilities use these shapes for collision;
`validateWorld` checks the scene definition. `renderWorldLayers` separates terrain
and objects for depth-sorted animation. Games define interactions, reach and
object-specific behavior.

Optional loading variants use a 48 × 48 construction grid with `void`,
`wireframe` and `floating` chunks. Those variants remove ground, paths, textures
and props at missing chunks. Custom worlds can present their own loading states.

## Asset delivery and review

Include the world assets your game uses and record their sources and permissions.
Keep editable sources in the project and load assets within the
sandbox's serving policy. Do not insert raw SVG supplied by players into the page.

Review the playable result on its target devices for readability, layout,
loading/errors and the interactions it actually uses. When using the SDK world
format, validate edited scenes and record prop
anchors and collision footprints. Document any custom renderer or asset build
steps with the game's run instructions.
