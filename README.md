# RTK & InfoWorks ICM Ground Infiltration Studio

Full-stack **React + TypeScript + AWS Amplify Gen 2** hydraulic modeling workbench for analyzing municipal sewer flow telemetry and rainfall hyetograph records, conditioning lift-station pump cycling, extracting clean 24-hour weekday/weekend dry-weather flow (DWF) patterns, isolating storm events, calibrating 3-unit RTK RDII hydrographs, and fitting the **InfoWorks ICM 2-Store Ground Infiltration Module (`hw_ground_infiltration`)** for multi-day groundwater recession tails.

## Key Capabilities

1. **Flexible Telemetry Upload & Unit Conversion**
   - Upload two-column CSV, TSV, or InfoWorks `CustomFile` `.txt` files for **Rainfall** (`in/hr`, `in`, `mm/hr`, `mm`) and **Sewer Flow** (`MGD`, `cfs`, `gpm`, `L/s`, `m³/s`) with configurable contributing **Service Area** (`acres`, `hectares`, `sq mi`, `km²`).
   - Built-in one-click sample dataset (`TFM02.txt` + `Rainfall.txt`, 268 acres).
2. **Upstream Pump-Cycle Detection & Zero-Phase Conditioning**
   - Automatically detects lift-station pump cycling intervals and applies a 2-pass centered running average matched to the cycle period.
3. **Interactive Split-Horizon Hyetograph × Hydrograph Canvas**
   - Synchronized inverted ceiling hyetograph and multi-layer sewer hydrograph with cursor-anchored wheel zoom, drag-box marquee zoom, pan, preset time windows (`48h`, `7d`, `30d`, `Full`), clickable storm badges (`E1`–`En`), and an overview minimap brush scrubber.
4. **Storm Event Identification & 3-Unit RTK Fitting**
   - Clusters wet-weather events using configurable inter-event gap and depth thresholds, fits `R1/T1/K1`, `R2/T2/K2`, `R3/T3/K3` unit hydrographs per storm, and flags long post-storm groundwater recession tails.
5. **Coupled InfoWorks ICM Ground Infiltration Calibration**
   - Calibrates fast/medium RTK alongside InfoWorks ICM's physical **Soil Store** (`S_max`, `S_init`, `S_thresh`, `k_perc`, `p_perc`, `ET`) and **Groundwater Store** (`G_init`, `G_thresh`, `k_gwi`, `p_gwi`, `G_bf_thresh`, `k_bf`) using Differential Evolution + bounded pattern polish, outputting ready-to-import ICM parameter CSV tables.
6. **AWS Amplify Gen 2 Backend (`amplify/`)**
   - **Auth (Login Gate)**: Amazon Cognito User Pool email sign-in, account registration with 6-digit email verification code, password reset, and signed-in header controls (`amplify/auth/resource.ts`, `src/components/AuthScreen.tsx`, `src/lib/authService.ts`)
   - **Data**: Cognito User Pool-protected AWS AppSync + DynamoDB `CalibrationProject` model (`amplify/data/resource.ts`)
   - **Storage**: Authenticated Amazon S3 bucket `rtkHydrologyStorage` for raw telemetry & exported tables (`amplify/storage/resource.ts`)
   - **Functions (Default Compute Engine)**: Serverless AWS Lambda `rtk-gim-calibrator` (Node 22, 2048 MB) executes all hydrological conditioning, 3-unit RTK fitting, and InfoWorks ICM 2-Store GIM Differential Evolution calibrations by default (`amplify/functions/rtk-gim-calibrator/`), using Gzip+Base64 GraphQL transport with automatic S3 overflow for multi-megabyte telemetry uploads.

## Local Development

```bash
npm install
npm run test:engine   # Verify hydrology & ICM GIM engine against TFM02 sample data
npm run dev           # Launch Vite dev server
```

## Deploying to AWS Amplify

1. In the **AWS Amplify Console**, choose **Create new app** -> **GitHub** and select `qiaoxin136/rtk-ground-infiltration`.
2. Amplify automatically detects `amplify.yml`, deploys the Gen 2 backend (`npx ampx pipeline-deploy`), generates `amplify_outputs.json`, and builds the Vite React TypeScript frontend (`npm run build`).
3. For local cloud sandbox testing:
   ```bash
   npx ampx sandbox
   ```
