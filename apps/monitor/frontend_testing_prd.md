# Frontend Testing PRD – Vanilla Monitor PWA

## 1. Project Overview & Context
Vanilla Monitor is a Progressive Web Application (PWA) designed for vanilla plantation supervisors to log field inspection data offline and synchronize it to Google Sheets and Google Drive when online. 

This Product Requirement Document (PRD) defines the specifications for automated and manual frontend testing, focusing on the three most critical components of the system:
1. **Multi-Step Form Navigation & State Validation** (Step 1 to Step 5)
2. **Offline Data Persistence (IndexedDB) & Sync Capability**
3. **Authentication Lifecycle & Security Controls**

---

## 2. Core Test Scenarios & Specifications

### Test Suite 1: Multi-Step Form Navigation & Validation
* **Objective**: Verify that a user can complete the 5-step form sequentially, that validations prevent proceeding with invalid data, and that state is preserved during transitions.
* **Workflow Steps**:
  * **Step 1 (Zone/Block/Plant)**: User selects Zone and Block cards, enters a numeric Plant ID. Button activates. Clicking navigates to `/inspect/step2`.
  * **Step 2 (Botanical)**: Form displays inputs for foliage status, flowers, and vine health. Clicking "Next" navigates to `/inspect/step3`.
  * **Step 3 (Care/Env)**: Form displays inputs for weed presence, soil moisture, and shade cover. Clicking "Next" navigates to `/inspect/step4`.
  * **Step 4 (Growth)**: Input fields for vine height (cm) and bean count. Clicking "Next" navigates to `/inspect/step5`.
  * **Step 5 (Submission)**: Option to snap/upload a photo and enter notes. Clicking "Submit" triggers local saving and network synchronization.
* **Assertions**:
  * Action buttons ("Next", "Back", "Submit") must be visible at the bottom of each page.
  * Form inputs are validated (e.g. plant number cannot be negative, heights must be valid numbers).
  * State remains intact when navigating back (e.g. if the user goes from Step 2 back to Step 1, the previously selected Zone/Block remains selected).

### Test Suite 2: Offline Persistence & Background Sync
* **Objective**: Verify that the application functions seamlessly offline, writing records locally to IndexedDB, and automatically pushing data to Google Sheets when internet connection returns.
* **Workflow Steps**:
  * Simulate offline mode (e.g. disable network connection or toggle mock offline switch).
  * Check that `OfflineBanner` displays a visual "Offline Mode" warning.
  * Complete the 5-step inspection and click "Submit".
  * Verify that the record is written to IndexedDB (`submissions` store).
  * Re-enable network connectivity.
  * Verify that `syncService` detects the network recovery, initiates sync, and updates the state (clears the queue).
* **Assertions**:
  * Offline banner changes state dynamically.
  * Submissions are uniquely keyed by `[Zone]-[Block]-[PlantNum]-[YYYYMMDD]-[HHMMSS]`.
  * Google Sheets API append succeeds upon sync completion.

### Test Suite 3: Auth Lifecycle & Access Control
* **Objective**: Verify that unauthorized users are redirected to the splash page and that authenticated users can log in via Google OAuth or the mock developer fallback.
* **Workflow Steps**:
  * Access protected pages (e.g., `/dashboard`, `/inspect/step1`) without tokens.
  * Verify automatic redirect to `/` (Splash screen).
  * Perform login via mock login developer path.
  * Verify storage of access tokens (`google_access_token`, `google_token_expiry`) in localStorage.
  * Verify redirect to `/dashboard`.
* **Assertions**:
  * Non-authenticated paths route back to Splash screen.
  * Expired tokens trigger the re-authentication overlay.

---

## 3. Test Automation Execution with TestSprite

To execute these tests using the TestSprite framework, follow these commands in order:

### Step 1: Bootstrap the TestSuite
This initializes the project test configuration. Since this is the initial setup, run:
```powershell
# Run this command to initialize TestSprite for the Next.js frontend
npx testsprite bootstrap --port 3000 --type frontend --path c:\Users\STZ\Desktop\Vanilla\frontend
```

### Step 2: Generate the Frontend Test Plan
Generate the automated test specifications for the login, multi-step navigation, and database state transitions:
```powershell
# Generates test cases focusing on multi-step forms and authentication
npx testsprite plan --path c:\Users\STZ\Desktop\Vanilla\frontend --needLogin true
```

### Step 3: Run the Test Plan
Execute the test cases against the local Next.js development server:
```powershell
# Run all generated test cases
npx testsprite execute --path c:\Users\STZ\Desktop\Vanilla\frontend --mode development
```
