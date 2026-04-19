# App Store Privacy Labels — CompassCHW iOS

**For use in App Store Connect → App Privacy section**
**Last updated:** April 18, 2026

When submitting the CompassCHW iOS app, Apple requires you to complete the
"App Privacy" questionnaire. Answer as follows.

---

## Data Used to Track You

**Answer: NO**

CompassCHW does not track users across apps or websites owned by other
companies. We do not use any third-party advertising SDKs, data brokers,
or cross-app identifiers.

---

## Data Linked to You

Select **all** of the following categories. For each, check the purposes listed.

### Health & Fitness
- **Health** (Medi-Cal ID, health conditions discussed in session notes)
  - Collected: Yes
  - Linked to user: Yes
  - Used for tracking: No
  - Purposes: App Functionality, Product Personalization

### Contact Info
- **Name** — App Functionality, Customer Support
- **Email Address** — App Functionality, Customer Support, Account Management
- **Phone Number** — App Functionality, Customer Support, Account Management
- **Physical Address** — App Functionality (ZIP code only for CHW matching)

### User Content
- **Photos or Videos** (profile photo only) — App Functionality
- **Audio Data** (session recordings with explicit consent) — App Functionality
- **Customer Support** (session notes, uploaded documents) — App Functionality

### Identifiers
- **User ID** — App Functionality, Analytics

### Usage Data
- **Product Interaction** — Analytics, App Functionality
- **Other Usage Data** — Analytics, App Functionality

### Diagnostics
- **Crash Data** — App Functionality
- **Performance Data** — App Functionality
- **Other Diagnostic Data** — App Functionality

---

## Data NOT Linked to You

None. All collected data is linked to the authenticated user account.

---

## Data Not Collected

- Financial Info (no credit cards — Medi-Cal billing is upstream)
- Location (precise GPS) — we only collect ZIP code, which is linked identifier
- Contacts
- Search History
- Sensitive Info beyond health
- Browsing History
- Purchases
- Gameplay Content
- Emails or Text Messages (we don't read user's email/SMS, only deliver our own)

---

## Additional Notes for Review Team

In the "App Review Information" section of App Store Connect:

**Contact Information**
- First name: Akram
- Last name: Mahmoud
- Phone: (provide)
- Email: akram.mahmoud-eng@joincompasschw.com

**Demo Account**
For the Apple reviewer, provide:
- Email: `reviewer-demo@joincompasschw.com`
- Password: [generate a strong unique password]
- Role: member (pre-populated with mock session history so reviewer can see
  the full UX end-to-end)

**Notes**
> CompassCHW is a HIPAA-covered business associate platform connecting
> Community Health Workers (CHWs) with California Medi-Cal members. The app
> facilitates session scheduling, secure messaging via masked phone numbers,
> and Medi-Cal billing on behalf of certified CHWs.
>
> All PHI is encrypted at rest (AES-256-GCM for Medi-Cal IDs, full-disk
> encryption on AWS RDS) and in transit (TLS 1.2+). We have a signed BAA
> with AWS. BAAs with Pear Suite, Vonage, and AssemblyAI are in progress
> before public launch.
>
> Public launch is limited to California-based Medi-Cal beneficiaries and
> certified CHWs. Other users will see a waitlist-only experience.
>
> For testing, the demo account is pre-approved for all roles and contains
> no real PHI.

**Sign-in Required**
Answer: Yes, all primary functionality requires sign-in.

**Age Rating (Content Descriptors)**
- Medical/Treatment Information: Infrequent/Mild
- Everything else: None
- Expected rating: **12+**

---

## Health App Entitlement

If you add HealthKit integration in the future:
- Declare `com.apple.developer.healthkit` in Entitlements
- Add `NSHealthShareUsageDescription` and `NSHealthUpdateUsageDescription`
  to Info.plist
- Justify access during review (sync CHW-assisted health goals with Apple Health)

**Not required for MVP launch.**

---

## Export Compliance

`ITSAppUsesNonExemptEncryption` is set to `false` in `app.json`.

This is correct because CompassCHW uses only:
- Standard TLS for network (exempt under §742.15(b)(1) of EAR)
- Apple's native keychain / SecureStore (exempt)
- AES-256-GCM from the `cryptography` Python library (used only server-side, not in the mobile binary)

No encryption export compliance filing is required.
