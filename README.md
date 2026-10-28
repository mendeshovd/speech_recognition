# Speaking Check

A browser tool for English tutors. It listens to a student speak, writes down each sentence, and marks grammar mistakes, filler words and speaking pace.

**Open it:** https://mendeshovd.github.io/speech_recognition/ (use Google Chrome)

## How to use

1. Type the student's name and pick their level.
2. Choose what to listen to:
   - **Microphone**: the student is in the room with you. Words appear live while they speak.
   - **Call audio (headphones)**: the student is on a video call. When Chrome asks what to share, pick the call's tab and keep **Share tab audio** on. If the call is in the Zoom, Teams or Skype app, pick **Entire screen** and turn on **Also share system audio**. Only the student's voice is checked, because your own voice is not in the call audio.
3. Press **Start listening**. Each sentence becomes a card when the student pauses:
   - red wavy underline: a grammar mistake, with the correction in green
   - yellow highlight: filler words such as "um", "you know", "basically"
   - clarity score (microphone only): a low score can point to unclear pronunciation
4. Press **Copy report** to copy a summary of the session for the student.

## Better feedback with Claude

Open **Settings and privacy** and paste an Anthropic API key from https://console.anthropic.com. Claude then checks each sentence for word choice and natural phrasing at the student's level. The key is stored only in your own browser, never in this repository.

## How it works

| Part | What it does |
| --- | --- |
| `index.html`, `styles.css` | The page |
| `app.js` | Recording, sentence detection, marking, report |
| `worker.js` | Runs the Whisper speech model in the browser for call audio ([transformers.js](https://github.com/huggingface/transformers.js)) |
| `capture-worklet.js` | Reads the audio stream for `worker.js` |

- **Microphone** uses Chrome's built-in speech recognition, which sends the audio to Google.
- **Call audio** uses Whisper running on your own computer. The model (about 80 MB for Base) downloads the first time and Chrome keeps it after that. It uses the graphics card when it can.
- Grammar is checked with the free [LanguageTool](https://languagetool.org) API, which allows about 20 checks per minute.

Each sentence's text is sent to LanguageTool, and to Anthropic when a key is set. Nothing is saved on a server.

## Known limits

- Whisper sometimes corrects small grammar slips while writing down speech, so a few mistakes may not show up in the text.
- Pronunciation is judged only by the clarity score, not by listening to the sound.

## Run locally

Browsers block the speech worker when the page is opened as a file, so serve the folder:

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000 in Chrome.
