//! Plays what the scenes asked for (wall::audio::Audio) through Bevy's audio: one player per sound,
//! despawned when done; the WAV bytes of a sound are made once.

use std::collections::HashMap;
use std::sync::Arc;

use bevy::audio::{AudioPlayer, AudioSource, PlaybackSettings, Volume};
use bevy::prelude::*;
use wall::audio::{Pcm, RATE};

/// Main world: what the output asked to play this frame.
#[derive(Resource, Default)]
pub struct SoundQueue {
    pub pending: Vec<(Pcm, f32)>,
    /// by the sound's address; the entry keeps the sound alive, so the address cannot be reused
    /// by another sound while it is cached
    cache: HashMap<usize, (Pcm, Handle<AudioSource>)>,
}

fn wav_bytes(pcm: &[f32]) -> Vec<u8> {
    let n = pcm.len() as u32;
    let mut b = Vec::with_capacity(44 + pcm.len() * 2);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + n * 2).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes()); // PCM
    b.extend_from_slice(&1u16.to_le_bytes()); // mono
    b.extend_from_slice(&RATE.to_le_bytes());
    b.extend_from_slice(&(RATE * 2).to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&(n * 2).to_le_bytes());
    for s in pcm {
        let v = (s.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        b.extend_from_slice(&v.to_le_bytes());
    }
    b
}

/// Spawns a player per requested sound (despawned when done).
pub fn play_sounds(mut q: ResMut<SoundQueue>, mut sources: ResMut<Assets<AudioSource>>, mut commands: Commands) {
    if q.pending.is_empty() {
        return;
    }
    let pending = std::mem::take(&mut q.pending);
    for (pcm, vol) in pending {
        let key = Arc::as_ptr(&pcm) as usize;
        let handle = match q.cache.get(&key) {
            Some((_, h)) => h.clone(),
            None => {
                if q.cache.len() >= 512 {
                    q.cache.clear();
                }
                let h = sources.add(AudioSource { bytes: wav_bytes(&pcm).into() });
                q.cache.insert(key, (pcm.clone(), h.clone()));
                h
            }
        };
        commands.spawn((AudioPlayer(handle), PlaybackSettings::DESPAWN.with_volume(Volume::Linear(vol))));
    }
}

