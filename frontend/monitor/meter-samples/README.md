# Meter photo samples

Real photos of the YIERYI 6-in-1 meter, used to calibrate and test the on-device reader
(`src/lib/meterOcr.ts`). Photos are git-ignored (large files); `labels.csv` is tracked.

```
meter-samples/
├── train/        photos used to calibrate the LCD layout
├── test/         held-back photos, only used to measure accuracy
├── labels.csv    the true reading of every photo
└── out/          created by the evaluation script (debug images)
```

Put roughly 70 % of the photos in `train/` and 30 % in `test/`. Mix conditions in both:
shade and sun, different angles and distances, different readings.

## labels.csv

One row per photo. `file` is the path relative to this folder. Leave a cell empty if the
value isn't shown or you aren't sure.

```
file,ph,ec,temperature,temp_unit,humidity,light_bars,moisture_drops
train/IMG_0001.jpg,6.4,0.04,25.2,C,81,7,4
test/IMG_0102.jpg,6.0,0.02,82.9,F,79,9,5
```

| Column | Meaning |
|---|---|
| ph | pH exactly as shown, e.g. `6.4` |
| ec | EC in mS/cm as shown, e.g. `0.04` |
| temperature | temperature as shown, e.g. `25.2` |
| temp_unit | `C` or `F` (the unit shown on the screen) |
| humidity | RH % as shown, e.g. `81` |
| light_bars | number of lit bars next to LIGHT |
| moisture_drops | number of lit drops under MOIST |

## Run the evaluation

From `frontend/monitor`:

```
npm run eval:meter            # all photos
npm run eval:meter -- test    # only test/
```

It prints the reading for every photo, accuracy per field, and writes the corrected screen
with the detected digits outlined to `out/` for every photo with a mistake.
