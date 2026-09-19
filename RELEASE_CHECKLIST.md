# Release checklist

1. Update `manifest.json` and `package.json` versions together.
2. Run `npm run verify`.
3. Load the unpacked extension in Chrome and reload Haddan.
4. Manual smoke checks:
   - popup toggle works on a Haddan tab;
   - market scan updates all configured resources;
   - START/STOP changes Poliana automation state;
   - Fairy resource choice is annotated without changing native links;
   - reward XP is captured before `Спасибо.` is acknowledged;
   - manual CAPTCHA pause resumes after the challenge disappears;
   - automatic CAPTCHA mode handles success and failure without exposing the API token in logs.
5. Run `npm run zip`.
6. Install the generated zip in a clean Chrome profile for one final smoke check.
