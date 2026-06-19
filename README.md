# Crocs B2C Commerce — Data Cloud Integration

This cartridge exports product catalog data from Salesforce B2C Commerce to Salesforce Data Cloud using the Ingestion API (Bulk mode) and JWT Bearer authentication.

---

## What It Does

1. Queries all online Master (Variation Base) Products from the CrocsUS site catalog
2. Builds a CSV with 6 fields: Product ID, Name, Short Description, Long Description, Online Flag, Product Type
3. Authenticates with Salesforce using JWT Bearer flow (server-to-server, no user login)
4. Exchanges the Salesforce Core token for a Data Cloud tenant token via `/services/a360/token`
5. Pushes the CSV to Data Cloud via the Bulk Ingestion API

---

## Repository Structure

```
b2c/
├── cartridges/
│   └── int_datacloud_catalog/
│       ├── cartridge/
│       │   └── scripts/
│       │       ├── datacloud/
│       │       │   ├── authService.js       # JWT signing + token exchange
│       │       │   └── ingestionService.js  # Data Cloud Bulk Ingestion API calls
│       │       └── jobs/
│       │           └── exportProductsToDataCloud.js  # Job entry point
│       ├── int_datacloud_catalog.properties
│       └── steptypes.json
├── dw.json.example
├── package.json
├── .gitignore
└── README.md
```

---

## Part 1: Salesforce Setup (fsmpartial sandbox)

### Step 1: Generate RSA Key Pair

Run these commands locally. Keys are stored at `orgs/crocs/dc-auth-keys/`.

```bash
# Generate private key
openssl genrsa -out datacloud_private_key.pem 2048

# Generate self-signed certificate (valid 365 days)
openssl req -new -x509 -key datacloud_private_key.pem \
  -out datacloud_certificate.pem -days 365 \
  -subj "/C=US/ST=CA/L=San Francisco/O=Salesforce/OU=FDE org/CN=Crocs partial sandbox/emailAddress=jasvir.dhillon@salesforce.com"

# Create PKCS12 bundle for Business Manager import
openssl pkcs12 -export \
  -out crocs_b2c_datacloud_key.p12 \
  -inkey datacloud_private_key.pem \
  -in datacloud_certificate.pem \
  -passout pass:CrocsDataCloud2026
```

> **Never commit `*.pem`, `*.der`, or `*.p12` files to git.**

---

### Step 2: Create External Client App in fsmpartial

1. Setup → **External Client App Manager** → **New External Client App**
2. Fill in:
   - App Name: `Crocs B2C DataCloud Ingestion`
   - Contact Email: `jasvir.dhillon@salesforce.com`
3. Click **Edit** on the app → OAuth Settings:
   - Callback URL: `https://login.salesforce.com/callback`
   - Selected OAuth Scopes:
     - `Manage Data Cloud Ingestion API data (cdp_ingest_api)`
     - `Manage user data via APIs (api)`
     - `Perform requests at any time (refresh_token, offline_access)`
   - Enable **JWT Bearer Flow**: ✅
   - Upload certificate: `datacloud_certificate.pem`
4. Save. Copy the **Consumer Key** shown — store it securely (goes in BM job parameters only).

---

### Step 3: Pre-authorize the User

1. External Client App Manager → `Crocs B2C DataCloud Ingestion` → **Manage**
2. Click **Edit Policies**:
   - Permitted Users: `Admin approved users are pre-authorized`
   - IP Relaxation: `Relax IP restrictions`
   - Save
3. Back on Manage page → **Select Profiles** → add `System Administrator`
4. Save

> **Important:** The Salesforce username used in the job (`SFUsername`) must match the exact username in Setup → Users — no dots vs dots matters. Use the value shown in the Username field, not the email.

---

### Step 4: Create Data Cloud Ingestion API Connector

1. Data Cloud Setup → **Ingestion API** → **New**
2. Connector Name: `CrocsCustomB2CConnector`
3. Upload schema file: `orgs/crocs/datacloud/product-ingestion-schema.yaml`
4. Create Data Stream:
   - Object: `Product`
   - Primary Key: `product_id`
   - Category: `Other`
   - Record Modified Field: leave blank
5. Deploy the data stream

---

### Step 5: Find Your Data Cloud Tenant URL

1. Data Cloud Setup → **Data Cloud Settings** (or check the URL when in Data Cloud Setup)
2. The tenant URL looks like: `https://xxxx.c360a.salesforce.com`
3. Alternatively, after JWT auth, the `instance_url` from the token response points to the Core org — the tenant URL must be obtained separately from DC Setup.

---

## Part 2: B2C Commerce Setup

### Step 1: Import Private Key into Business Manager

1. Business Manager → **Administration → Operations → Private Keys and Certificates**
2. Click **Import**
3. Upload `crocs_b2c_datacloud_key.p12`
4. Password: `yourpassword`
5. Alias: `crocs_b2c_datacloud_key`
6. Save

---

### Step 2: Deploy the Cartridge

**Prerequisites:** Node.js installed, access key with WebDAV File Access and UX Studio role.

```bash
# Clone/navigate to the repo
cd /path/to/orgs/crocs/b2c

# Install dependencies
npm install

# Create dw.json from template (DO NOT COMMIT THIS FILE)
cp dw.json.example dw.json
```

Edit `dw.json`:
```json
{
    "hostname": "aadb-009.dx.commercecloud.salesforce.com",
    "username": "jasvir.dhillon@salesforce.com",
    "password": "YOUR-ACCESS-KEY-HERE",
    "code-version": "NeerajVersion"
}
```

> Get the access key from: BM → Administration → Organization → WebDAV Client Permissions → generate a new key.

```bash
# Upload cartridge to sandbox
npx dwupload --cartridge cartridges/int_datacloud_catalog
```

Expected output:
```
[HH:MM:SS] Successfully uploaded cartridge: cartridges/int_datacloud_catalog
[HH:MM:SS] Done!
```

---

### Step 3: Register Cartridge in Business Manager

1. BM → **Administration → Sites → Manage Sites → Business Manager → Settings**
2. Add `int_datacloud_catalog` to the **start** of the Cartridges field
3. Save

---

### Step 4: Configure the Job

1. BM → **Administration → Operations → Job Schedules → New Job**
2. Job ID: `ExportProductsToDataCloud`
3. **Add Step** → search for `custom.ExportProductsToDataCloud`
4. Set all parameters:

| Parameter | Value | Notes |
|---|---|---|
| `InstanceURL` | `https://crocsneworg--fsmpartial.sandbox.my.salesforce.com` | Salesforce Core My Domain URL |
| `ConsumerKey` | *(from External Client App)* | Do not hardcode in scripts |
| `SFUsername` | `jasvirdhillon@salesforce.com` | Exact username from SF Setup → Users |
| `ConnectorName` | `CrocsCustomB2CConnector` | Case-sensitive, must match DC Setup |
| `ObjectName` | `Product` | Case-sensitive, must match DC data stream |
| `DataCloudInstanceURL` | `https://xxxx.c360a.salesforce.com` | Data Cloud tenant URL from DC Setup |

5. Scope: **Sites → crocs_us**
6. Save → **Run Now**

---

### Step 5: Verify in Data Cloud

After a successful run:
1. Data Cloud → **Data Explorer** → select `Product` DMO
2. Rows should appear within a few minutes of `JobComplete`

---

## Authentication Flow

```
B2C Job
  │
  ├─ Step 1: JWT Bearer POST to InstanceURL/services/oauth2/token
  │          JWT signed with RS256 using crocs_b2c_datacloud_key (PKCS12 in BM)
  │          → Returns: Salesforce Core access_token + instance_url
  │
  ├─ Step 2: Token exchange POST to instance_url/services/a360/token
  │          grant_type=urn:salesforce:grant-type:external:cdp
  │          → Returns: Data Cloud access_token
  │
  └─ Step 3: Data Cloud Bulk Ingestion API calls using DC token
             POST DataCloudInstanceURL/api/v1/ingest/jobs
             PUT  .../jobs/{id}/batches  (CSV upload)
             PATCH .../jobs/{id}         (close job)
             GET  .../jobs/{id}          (poll status)
```

---

## Data Cloud Product Schema

| Field | Type | Source |
|---|---|---|
| `product_id` | string (PK) | `product.getID()` |
| `product_name` | string | `product.getName()` |
| `short_description` | string | `product.getShortDescription()` |
| `long_description` | string | `product.getLongDescription()` |
| `online_flag` | boolean | `product.isOnline()` |
| `product_type` | string | hardcoded `"Variation Base Product"` |

---

## B2C Commerce Scripting — Key Lessons Learned

| Issue | Fix |
|---|---|
| Job parameter access | Use `parameters.InstanceURL` not `parameters.InstanceURL.stringValue` |
| Require paths in job scripts | Full path: `require('int_datacloud_catalog/cartridge/scripts/...')` not `require('*/...')` |
| `HTTPClient` error body | Use `client.text \|\| client.errorText` — `text` is null on error responses |
| `signer.sign()` output | Already returns Base64 — do not wrap with `StringUtils.encodeBase64()` |
| `signer.sign()` input | Pass `StringUtils.encodeBase64(signingInput)` — the API expects Base64-encoded input |
| JS string quota | B2C caps JS strings at 1MB — filter master products only to stay under limit |
| Job scope | Must be Sites → crocs_us (not Organization) for `ProductSearchModel` to work |
| `steptypes.json` | Inner key must be `"parameters"` (plural) with `"parameters"` array inside |
| Salesforce username | Sandbox username has no dot: `jasvirdhillon@salesforce.com` not `jasvir.dhillon@salesforce.com` |
| Data Cloud token | Core JWT Bearer token cannot call DC API directly — must exchange via `/services/a360/token` |
| DC grant type | Use `urn:salesforce:grant-type:external:cdp` with `subject_token` param |

---

## Troubleshooting

**Step type not appearing in Business Manager**
- Verify cartridge is on Business Manager site cartridge path
- Log out and back into BM after uploading

**`invalid_grant` / `invalid assertion`**
- Signature encoding issue — `signer.sign()` already returns Base64, do not double-encode

**`invalid_client` / `invalid client credentials`**
- Consumer key mismatch — verify against live External Client App UI
- Certificate mismatch — verify PKCS12 cert fingerprint matches cert uploaded to ECA
- Wrong username — check exact username in SF Setup → Users (sandbox may differ from email)

**`invalid subject token` on DC token exchange**
- Wrong grant type — use `urn:salesforce:grant-type:external:cdp`
- Wrong param name — use `subject_token` not `app_token` or `app_actor_token`

**`404` on Data Cloud API**
- Using Salesforce Core URL instead of DC tenant URL (`*.c360a.salesforce.com`)

**`401` on Data Cloud API**
- Using Core access token directly — must exchange for DC token first via `/services/a360/token`

**`400` on createJob**
- Connector name or object name case mismatch — must exactly match Data Cloud Setup
- DC token exchange silently failed — check authService log for exchange response

**Check logs at:**
- BM → Administration → Operations → Log Center → `exportProductsToDataCloud`

---

## Security Notes

- Never commit `dw.json` to git (contains sandbox credentials)
- Never commit `*.pem`, `*.der`, `*.p12` key files
- Rotate the B2C Access Key after sharing in any session
- Consumer Key goes in BM job parameters only, never in code
- PKCS12 password: stored in team password manager (not in this file)
