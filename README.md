# B2C Commerce — Data Cloud Catalog Integration

This cartridge exports product catalog data from Salesforce B2C Commerce to Salesforce Data Cloud using the Ingestion API (Bulk mode) and JWT Bearer authentication.

---

## What It Does

1. Queries **all online products** from the site catalog using `ProductMgr.queryAllSiteProducts()` — includes masters, variants, bundles, sets, and simple products; offline products are excluded
2. Builds a CSV with 12 fields: `product_id`, `product_name`, `short_description`, `long_description`, `online_flag`, `product_type`, `online_from`, `online_to`, `last_modified`, `creation_date`, `brand`, `manufacturer_name`
3. Uploads in batches of 500 rows to stay within B2C Commerce's 1MB JS string quota
4. Authenticates with Salesforce using JWT Bearer flow (server-to-server, no user login required)
5. Exchanges the Salesforce Core token for a Data Cloud tenant token via `/services/a360/token`
6. Pushes each CSV batch to Data Cloud via the Bulk Ingestion API, then polls until `JobComplete`

---

## Repository Structure

```
b2c/
├── cartridges/
│   └── int_datacloud_catalog/
│       ├── cartridge/
│       │   └── scripts/
│       │       ├── datacloud/
│       │       │   ├── authService.js       # JWT signing + two-step token exchange
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

## Part 1: Salesforce Core Setup

### Step 1: Generate RSA Key Pair

Run these commands locally. Store the generated files outside the repo (they must never be committed).

```bash
# Generate private key
openssl genrsa -out datacloud_private_key.pem 2048

# Generate self-signed certificate (valid 365 days)
openssl req -new -x509 -key datacloud_private_key.pem \
  -out datacloud_certificate.pem -days 365 \
  -subj "/C=US/ST=CA/L=San Francisco/O=YourOrg/OU=Engineering/CN=b2c-datacloud"

# Create PKCS12 bundle for Business Manager import, by updating passout pass. 
openssl pkcs12 -export \
  -out b2c_datacloud_key.p12 \
  -inkey datacloud_private_key.pem \
  -in datacloud_certificate.pem \
  -passout pass:your-chosen-password
```
> Note your-chosen-password it will be needed in **Step 1 of B2C Commerce Setup**
> **Never commit `*.pem`, `*.der`, or `*.p12` files to git.**

---

### Step 2: Create an External Client App

1. In Salesforce Core: Setup → **External Client App Manager** → **New External Client App**
2. Fill in:
   - App Name: any descriptive name (e.g. `B2C DataCloud Ingestion`)
   - Contact Email: your email
3. Scroll Down and Expand **API(Enable OAuth Settings)**:
   - Enable **Enable OAuth**: ✅
   - Callback URL: `https://login.salesforce.com/callback`
   - Selected OAuth Scopes:
     - `Manage Data Cloud Ingestion API data (cdp_ingest_api)`
     - `Manage user data via APIs (api)`
     - `Perform requests at any time (refresh_token, offline_access)`
   - Enable **JWT Bearer Flow**: ✅
   - Upload certificate: `datacloud_certificate.pem` (the `.pem` file, not the `.p12`)
4. Save. 
5. Goto **Settings** -> **OAuth Settings** Copy the **Consumer Key** — it goes in BM job parameters only (never in code).

---

### Step 3: Pre-authorize a User for JWT Bearer

The JWT `sub` claim must match a Salesforce user who is explicitly pre-authorized on the app.

1. External Client App Manager → your app → Click **Edit Policies**:
2. App Policies
   - Start Page - OAuth.
   - Permitted Users: `Admin approved users are pre-authorized`
   - Select Profiles: add the profile of the user you'll use (e.g. `System Administrator`)
   - Select Permission Sets: `Customer 360 Data Platform Integration`
3. OAuth Policies:
   - Permitted Users: `Admin approved users are pre-authorized`
   - OAuth Start URL: `https://login.salesforce.com`
   - IP Relaxation: `Relax IP restrictions`
   - Refresh Token Policy: `Refresh token is valid until revoked`
4. Save

> **Important:** The username in the job parameter (`SFUsername`) must exactly match the **Username** field in Setup → Users — not the email address. In sandboxes these often differ.

---

### Step 4: Create a Data Cloud Ingestion API Connector

1. Data Cloud Setup → **Ingestion API** → **New**
2. Choose a connector name (you'll use this exact value in the `ConnectorName` job parameter)
3. Upload your schema file defining the `Product` object with the 6 fields (see schema below)
4. Create a Data Stream:
   - Object: `Product`
   - Primary Key: `product_id`
   - Category: `Other`
   - Record Modified Field: leave blank
5. Deploy the data stream

---

### Step 5: Find Your Data Cloud Tenant URL

1. Data Cloud Setup → **Data Cloud Settings**
2. The tenant URL looks like: `https://xxxx.c360a.salesforce.com`
3. Use this as the `DataCloudInstanceURL` job parameter — this is **different** from the Salesforce Core My Domain URL

---

## Part 2: B2C Commerce Setup

### Step 1: Import Private Key into Business Manager

1. BM → **Administration → Operations → Private Keys and Certificates**
2. Click **Import**
3. Upload your `.p12` file
4. Enter the password you set during PKCS12 creation from **Step 1 of Salesforce Core Setup**
5. Set an **Alias** — this is the value you'll use for the `PrivateKeyAlias` job parameter (e.g. `b2c_datacloud_key`)
6. Save

---

### Step 2: Deploy the Cartridge

**Prerequisites:** Node.js installed, B2C access key with WebDAV File Access and UX Studio role. Ensure this repo is clone locally.

```bash
# Navigate to the b2c directory
cd /path/to/home/of/repo

# Install dependencies
npm install

# Create dw.json from template (DO NOT COMMIT THIS FILE)
cp dw.json.example dw.json
```

Edit `dw.json`:
```json
{
    "hostname": "your-instance.dx.commercecloud.salesforce.com",
    "username": "your.username@example.com",
    "password": "YOUR-ACCESS-KEY-HERE",
    "code-version": "your-code-version"
}
```

> Get the access key from: BM → Administration → Organization → WebDAV Client Permissions → generate a new key.

```bash
# Upload cartridge to your instance
npx dwupload --cartridge cartridges/int_datacloud_catalog
```

---

### Step 3: Register Cartridge in Business Manager

1. BM → **Administration → Sites → Manage Sites → Business Manager Site → Manage the Business Manager site.**
2. Add `int_datacloud_catalog:` to the **start** of the Cartridges field
3. Apply

---

### Step 4: Configure the Job

1. BM → **Administration → Operations → Jobs → New Job**
2. Job ID: `ExportProductsToDataCloud` (or any name)
3. **Job Steps** →**Configure a Step** → search for `custom.ExportProductsToDataCloud`
4. Set all parameters:

| Parameter | Example Value | Notes |
|---|---|---|
| `InstanceURL` | `https://yourorg.sandbox.my.salesforce.com` | Salesforce Core My Domain URL — find it in SF Setup → My Domain. Do **not** use the Lightning UI URL (`lightning.force.com`) |
| `ConsumerKey` | *(from External Client App)* | Do not hardcode in scripts |
| `SFUsername` | `youruser@yourorg.sandbox` | Exact username from SF Setup → Users |
| `ConnectorName` | `MyB2CConnector` | Case-sensitive, must match DC Setup |
| `ObjectName` | `Product` | Case-sensitive, must match DC data stream object |
| `DataCloudInstanceURL` | `https://xxxx.c360a.salesforce.com` | Data Cloud tenant URL from DC Settings |
| `PrivateKeyAlias` | `b2c_datacloud_key` | Alias set during PKCS12 import in BM |

5. Scope: **Sites → your site** (required for `ProductMgr` to query the correct catalog)
6. Save → **Run Now**

---

### Step 5: Verify in Data Cloud

After a successful run:
1. Data Cloud → **Data Explorer** → select your `Product` DMO
2. Rows appear within a few minutes of `JobComplete`

---

## Authentication Flow

```
B2C Job
  │
  ├─ Step 1: JWT Bearer POST to InstanceURL/services/oauth2/token
  │          JWT signed RS256 using private key alias (PKCS12 stored in BM)
  │          → Returns: Salesforce Core access_token + instance_url
  │
  ├─ Step 2: Token exchange POST to instance_url/services/a360/token
  │          grant_type=urn:salesforce:grant-type:external:cdp
  │          → Returns: Data Cloud access_token
  │
  └─ Step 3: Data Cloud Bulk Ingestion API using DC token
             POST DataCloudInstanceURL/api/v1/ingest/jobs
             PUT  .../jobs/{id}/batches  (CSV, one PUT per batch)
             PATCH .../jobs/{id}         (close job → UploadComplete)
             GET  .../jobs/{id}          (poll until JobComplete)
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
| `product_type` | string | derived from boolean methods (see note) |
| `online_from` | datetime | `product.getOnlineFrom()` |
| `online_to` | datetime | `product.getOnlineTo()` |
| `last_modified` | datetime | `product.getLastModified()` |
| `creation_date` | datetime | `product.getCreationDate()` |
| `brand` | string | `product.getBrand()` |
| `manufacturer_name` | string | `product.getManufacturerName()` |

> **Note on `product_type`:** B2C Commerce's `dw.catalog.Product` API does not expose a `getProductType()` method — the platform only provides boolean methods: `isMaster()`, `isVariant()`, `isBundle()`, `isProductSet()`. The `product_type` field is derived using a ternary chain over these booleans:
>
> - `isMaster()` → `"Variation Base Product"`
> - `isVariant()` → `"Variation Product"`
> - `isBundle()` → `"Bundle"`
> - `isProductSet()` → `"Set"`
> - otherwise → `"Product"`
>
> These label strings can be renamed to suit your Data Cloud model. Apply product type filtering downstream in Data Cloud if needed.

---

## Troubleshooting

**Step type not appearing in Business Manager**
- Verify `int_datacloud_catalog` is on the Business Manager site cartridge path (not just a storefront site): BM → Administration → Sites → Manage Sites → Business Manager → Settings → Cartridges
- Log out and back into BM after uploading
- Validate `steptypes.json` was parsed correctly: BM → Administration → Operations → Job Step Types — `int_datacloud_catalog` should show as `valid`
- If valid but still not appearing, force a full step type rescan by toggling the active code version: BM → Administration → Site Development → Code Versions → activate any other version → immediately activate `moderate` again. This forces the application server to reload all step type registrations.

**`invalid_grant` / `invalid assertion`**
- Certificate mismatch — verify that the `.pem` uploaded to the External Client App matches the private key in the `.p12` imported into BM (they must be a keypair)
- `signer.sign()` already returns Base64 — do not double-wrap with `StringUtils.encodeBase64()`

**`invalid_client` / `invalid client credentials`**
- Consumer key mismatch — verify against the live External Client App UI
- Wrong username — check the exact value in SF Setup → Users; sandbox usernames often differ from email addresses

**`invalid subject token` on DC token exchange**
- Wrong grant type — must be `urn:salesforce:grant-type:external:cdp`
- Wrong param name — must be `subject_token`, not `app_token` or `app_actor_token`

**`404` on Data Cloud API**
- Using Salesforce Core URL instead of Data Cloud tenant URL (`*.c360a.salesforce.com`)

**`401` on Data Cloud API**
- Using Core access token directly — must exchange for DC token first via `/services/a360/token`

**`400` on createJob**
- Connector name or object name case mismatch — must exactly match what's in Data Cloud Setup
- Check the error body for detail

**Check logs at:**
BM → Administration → Operations → Log Center → custom log `exportProductsToDataCloud`

---

## Security Notes

- Never commit `dw.json` to git (contains sandbox credentials)
- Never commit `*.pem`, `*.der`, or `*.p12` key files
- Rotate the B2C Access Key after sharing in any session
- Consumer Key goes in BM job parameters only, never in code
- PKCS12 password: store in your team's password manager
