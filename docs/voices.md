# Voices

Real ElevenLabs voice ids, checked on 27 Sep 2026. Use one of these, or an id
that `ELEVENLABS_GET_VOICES` returns for the account. Never write an id from
memory: a wrong id fails, or worse, speaks with a voice nobody chose.

One voice per speaker, the same id, model and settings for every line.
Characters get clearly different voices; a narrator gets a warm, steady one.

## English: default voices (every ElevenLabs account has them)

| Voice | voice_id | Sounds like | Good for |
|---|---|---|---|
| George | `JBFqnCBsd6RMkjVDRZzb` | Male, British, warm storyteller | Narrator |
| Alice | `Xb7hH8MSUJpSbSDYk0k2` | Female, British, clear educator | Narrator, explainers |
| Daniel | `onwK4e9ZLuTAKqWW03F9` | Male, British, steady broadcaster | Announcements |
| Sarah | `EXAVITQu4vr4xnSDxMaL` | Female, American, reassuring | Product, support |
| Brian | `nPczCjzI2devNBz1zQrb` | Male, American, deep and comforting | Calm narration |
| Jessica | `cgSgspJ2msm6clMCkdW9` | Female, young, American, playful | Cheerful character |
| Laura | `FGY2WhTYpPnrIDTdsKH5` | Female, young, American, quirky | Funny character |
| Lily | `pFZP5JQG7iQjIQuC4Bku` | Female, British, velvety | Elegant character |
| Liam | `TX3LPaxmHKxFdv7VOQHJ` | Male, young, American, energetic | Hype, social media |
| Charlie | `IKne3meq5aSn9XLyUdCD` | Male, young, Australian, hyped | Energetic character |
| Chris | `iP95p4xoKVk53GoZ742B` | Male, American, casual | Friendly character |
| Bill | `pqHfZKP75CvOlQylNhV4` | Male, older, American, wise | Mentor, grandpa |

## French: Voice Library voices (native speakers)

These live in the ElevenLabs Voice Library. When `ELEVENLABS_GET_VOICES` does
not list one for the account, add it first with `ELEVENLABS_ADD_SHARING_VOICE`
(`public_user_id`, `voice_id`, `new_name` from the table), or pick another voice.

| Voice | voice_id | public_user_id | Sounds like | Good for |
|---|---|---|---|---|
| Julia | `mNu8EQcIlFZdOJs7yfhe` | `29953a0c704089a7251918e3bac7696c96c21e47bb5986e11993f670629cad45` | Female, young, Parisian, warm | Narratrice |
| Martin Dupont | `wyZnrAs18zdIj8UgFSV8` | `e9a6840c69b79812b77ea81fa11d55aaf80dcf1938fa0137bf7f514f67f75c99` | Male, mature, deep, warm | Narrateur, personnage âgé |
| Emilie | `i6ke7jvmGEVUyV4zjSaT` | `c96a60f175f9cda55b0d4f08cebf47fc72a91a94188b461522707055362ee021` | Female, young, Parisian, clear and professional | Personnage pro |
| Chloé | `Hy28BjVfgieDVMiyQpQe` | `35872a3bbdcf2ab5c31f372e17a9de68e06558dc42a401f6aa9b4f946dd07ca9` | Female, warm and friendly | Personnage sympathique, réseaux sociaux |
| Léo | `jsScnYkNNda9Q1NES5nn` | `b93a441072478a6c07e14c6b5d7dc7b6f42425247e3687d71473dc8d840140d3` | Male, young, energetic | Personnage dynamique |
| Hugo | `IbbR6Av0dWuQJS0b8JVT` | `2eff6bde584aa6471c181410ab4bb82907fd07a91c7daf2d6f90fd262282a900` | Male, young, warm and grounded | Personnage jeune |
| Sébastien | `BUJMBsQ3Oq4cEeWSb48y` | `a0bdfd7ee0a5f2af6ab593a5d7235be2c86f4b7d43cb8abd55b95a982b2d3aa8` | Male, 35, natural (paid ElevenLabs plans only) | Personnage posé |

A default English voice can also speak French with `eleven_multilingual_v2`,
with an accent: fine for a character, less so for a narrator.

## Models

Always set `model_id`; the text-to-speech tool's default model is English-only.

| model_id | When |
|---|---|
| `eleven_multilingual_v2` | Default choice: steady, 29 languages. |
| `eleven_v3` | Most expressive; understands audio tags like `[excited]`, `[whispers]`, `[giggles]`. |
