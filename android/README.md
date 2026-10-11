# Getting DilliJalNav Edge onto an Android phone

Three ways, in the order you will actually need them.

---

## 1. Right now, for testing on your phone (2 minutes, no build)

The app is a PWA. `npm run dev` serves it over HTTPS on your LAN, and Chrome on
Android gives a web page the **same camera, GPS, motion sensors, speech and
video recording** a native app gets.

```bash
cd app && npm run dev
```

Vite prints something like `https://192.168.1.7:5173/`. On the phone (same
wifi) open that URL, accept the self-signed-certificate warning
(*Advanced → Proceed*), and allow camera + location.

> The certificate warning is only because `npm run dev` self-signs. It goes away
> the moment the app is on a real host (step 2).

## 2. For a live demo and hosting (10 minutes, a real URL)

Deploy once and everyone can open it, including on iPhones.

```bash
cd app && npm run build        # → app/dist
```

Push the repo to GitHub, then on **Vercel** or **Netlify**: import the repo, set
root directory `app`, build command `npm run build`, output directory `dist`.
Set `VITE_API_BASE` to your backend URL (see [`../server/`](../server)) or
deploy the backend and serve `app/dist` from it — `server/main.py` already
mounts `app/dist` at `/` when it exists, so one host can serve everything.

On the phone: open the URL → Chrome menu → **Add to Home screen**. It launches
fullscreen with no browser chrome, has its own icon, and works offline.
For most demos this is indistinguishable from a native app.

## 3. For the Play Store (a real signed `.aab`)

Google ships [Trusted Web Activity](https://developer.chrome.com/docs/android/trusted-web-activity/):
a genuine Android app whose UI is your PWA rendered by Chrome, with **full
access to camera, GPS and storage**. Play Store accepts these; Bubblewrap is
Google's own tool for generating them.

```bash
npm install -g @bubblewrap/cli
bubblewrap init --manifest https://YOUR-DOMAIN/manifest.webmanifest
bubblewrap build        # → app-release-bundle.aab + a signing keystore
```

Then:

1. **Keep the keystore and its passwords safe.** Lose them and you can never
   update the listing.
2. Bubblewrap prints an SHA-256 fingerprint. Publish it at
   `https://YOUR-DOMAIN/.well-known/assetlinks.json` — see
   [`assetlinks.example.json`](assetlinks.example.json). Without this the app
   opens with a browser address bar visible.
3. Upload the `.aab` at [play.google.com/console](https://play.google.com/console).
   A developer account is a one-time **$25**.
4. In the Play Console data-safety form, declare: camera and location are used
   **on-device only**; the only data leaving the phone is anonymous hazard
   coordinates. That is true of this codebase and is worth saying on stage.

Review typically takes a few days for a new developer account — start the
account creation now if you want it live for the finals, and demo via step 2
in the meantime.

### If you later need something the web cannot do

Background camera capture with the screen off, or foreground-service recording,
needs native code. At that point the port is Flutter + `tflite_flutter`, reusing
[`ml/`](../ml) unchanged (export TFLite instead of ONNX — `ml/train.py` changes
one word) and porting [`app/src/hazards.ts`](../app/src/hazards.ts), which is
plain arithmetic with no browser dependency. Nothing in this prototype is
throwaway.

---

## Mounting the phone

Any ₹300–600 handlebar clamp works. What matters for accuracy:

- **Landscape or portrait is fine** — but keep it consistent, and re-run the
  calibration in Settings if you change it.
- Aim so the **horizon sits slightly above the middle** of the frame; the
  default calibration assumes `0.45`.
- Measure the lens height off the road and enter it in Settings. The distance
  estimate is directly proportional to it, and a wrong height means warnings
  arrive at the wrong moment.
