"use strict";
require("dotenv").config();
const speech = require("@google-cloud/speech");

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_NUMBER || "797117582796";

async function test(languages) {
  console.log(`\nTesting languages:`, languages);
  const client = new speech.v2.SpeechClient({
    apiEndpoint: "us-central1-speech.googleapis.com",
  });
  const recognizer = `projects/${PROJECT_ID}/locations/us-central1/recognizers/_`;

  return new Promise((resolve) => {
    const stream = client._streamingRecognize();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };

    const timeout = setTimeout(() => {
      console.log("✅ ACCEPTED:", languages);
      stream.destroy();
      finish();
    }, 3000);

    stream.on("error", (err) => {
      clearTimeout(timeout);
      console.log(`❌ REJECTED:`, languages, `\n   Error: [${err.code}] ${err.message}`);
      finish();
    });

    stream.write({
      recognizer,
      streamingConfig: {
        config: {
          explicitDecodingConfig: {
            encoding: "LINEAR16",
            sampleRateHertz: 16000,
            audioChannelCount: 1,
          },
          languageCodes: languages,
          model: "chirp_2",
        },
        streamingFeatures: {
          interimResults: false,
        }
      },
    });
  });
}

async function run() {
  await test(["auto"]);
  await test(["si-LK"]);
  await test(["si-LK", "en-US"]);
  await test(["si-LK", "ta-IN", "en-US"]);
}

run();
