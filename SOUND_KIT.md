# FriendSDK sound kit

The optional shared kit provides sounds for choices, purchases, activities,
reveals and rewards. Use it, your own audio, or no audio to suit the game. The
fishing reference demonstrates the shared kit.

The palette uses rounded sine/triangle plucks, warm low notes, soft ticks and ascending three-note pickups. All cues are synthesized from code, with no recordings or external samples. Source attribution is recorded in `assets/sound-provenance.json`.

## Use the module

`@rarefriends/friendsdk/sounds` has no framework dependency. Creating a kit does not create an audio context. Call `unlock()` directly from a player gesture; do not call it on page load. Muted, locked, hidden, and disposed players do not queue sounds for later playback.

```js
import { createFriendSoundKit } from '@rarefriends/friendsdk/sounds';

const sounds = createFriendSoundKit({ volume: 0.65 });

playButton.addEventListener('click', async () => {
  if (await sounds.unlock()) sounds.play('action-start');
});

// Later, after the game has been unlocked:
sounds.play('action-ready');
sounds.setMuted(true); // Stops current voices as well.
sounds.setVolume(0.5);
sounds.stop();        // Cancel an interrupted sequence.
sounds.dispose();     // Release the context/listeners on game unmount.
```

`play()` returns whether playback started. It never unlocks audio itself. `unlock()` resolves to false if audio is unavailable or resume fails, so games remain playable without sound. The kit stops voices when its document becomes hidden. Provide an explicit mute control in games with audio; when using this kit, call `stop()` when closing a reveal, resetting, or leaving the experience. No background music is started automatically.

## Cues

| ID | Use |
| --- | --- |
| `select` | A choice or small UI action |
| `purchase` | A completed local purchase |
| `action-start` | An activity starting |
| `action-ready` | An activity ready to resolve |
| `anticipation` | Tension before an outcome |
| `impact` | An emergence or impact |
| `reveal-common` | A small reward; also used for uncommon items |
| `reveal-rare` | A brighter rare reward |
| `reveal-legendary` | The fullest reward resolution |
| `reward` | A pickup, sale, or shortened reveal |

`FRIEND_SOUND_IDS` and `FRIEND_SOUND_CUES` expose the inventory and metadata. `renderFriendSound(id, { sampleRate: 48000 })` returns deterministic mono float PCM without creating an audio context. The player caches generated buffers and limits simultaneous cues; its conservative master level leaves mixing headroom.

## Pair sounds with a reveal

The reveal component is independent of audio. Wire its phase callback to your own sound kit, or use the fishing example as a complete reference:

```tsx
import { RewardReveal } from '@rarefriends/friendsdk/reveal';
import '@rarefriends/friendsdk/reveal.css';

<RewardReveal
  item={chosenItem}
  revealKey={settledReward.id}
  onPhase={(phase, item) => {
    if (phase === 'anticipation') sounds.play('anticipation');
    if (phase === 'emergence') sounds.play('impact');
    if (phase === 'reveal') sounds.play(
      item.rarity === 'legendary' ? 'reveal-legendary'
        : item.rarity === 'rare' ? 'reveal-rare' : 'reveal-common'
    );
  }}
  onComplete={(_item, reason) => {
    if (reason !== 'finished') {
      sounds.stop();
      sounds.play('reward');
    }
  }}
/>
```

Give the reveal a bounded container. Pass the already chosen item to it; neither the animation nor audio selects an outcome or authorizes a payout. Reduced motion and skipping go straight to the result without firing all the intermediate cues. The host should stop sound when the component is removed.
