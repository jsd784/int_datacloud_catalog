# B2C Commerce — Data Cloud Catalog Integration

This cartridge exports product catalog data from Salesforce B2C Commerce to Salesforce Data Cloud using the Ingestion API (Bulk mode) and OAuth 2.0 Client Credentials authentication.

---

## What It Does

1. Queries all **online** products from the site catalog using `ProductMgr.queryAllSiteProducts()` — includes masters, variants, bundles, sets, and simple products; offline products are skipped
2. Builds a CSV with 13 fields: `product_id`, `product_name`, `short_description`, `long_description`, `online_flag`, `product_type`, `online_from`, `online_to`, `last_modified`, `creation_date`, `brand`, `manufacturer_name`, `in_stock`
3. Uploads in character-size-aware batches to stay within B2C Commerce's 1MB JS string quota
4. Authenticates with Salesforce using OAuth 2.0 Client Credentials flow via a single registered B2C Service
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
│       │       │   ├── authService.js       # Client Credentials + two-step token exchange
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

### Step 1: Create an External Client App

The cartridge uses OAuth 2.0 Client Credentials flow — only a Consumer Key and Consumer Secret are needed.

1. In Salesforce Core: Setup → **External Client App Manager** → **New External Client App**
2. Fill in:
   - App Name: any descriptive name (e.g. `B2C DataCloud Ingestion`)
   - Contact Email: your email
3. Scroll down and expand **API (Enable OAuth Settings)**:
   - Enable **Enable OAuth**: ✅
   - Callback URL: `https://login.salesforce.com/callback`
   - Selected OAuth Scopes:
     - `Manage Data Cloud Ingestion API data (cdp_ingest_api)`
     - `Manage user data via APIs (api)`
     - `Perform requests at any time (refresh_token, offline_access)`
   - Enable **Client Credentials Flow**: ✅ (do **not** enable JWT Bearer Flow)
4. Save.
5. Go to **Settings** → **OAuth Settings** → copy the **Consumer Key** and **Consumer Secret** — these go into the BM Service credential (never in code).

---

### Step 2: Create a Run-As Integration User

The Client Credentials flow executes as a named Salesforce user — create a dedicated integration user rather than using a personal account.

1. Setup → **Users** → **New User**
2. Fill in:
   - First Name: `B2C DataCloud`
   - Last Name: `Integration`
   - Email: your team's shared email
   - Username: any unique value (e.g. `b2c.datacloud.integration@yourorg.com`)
   - User License: `Salesforce`
   - Role/Profile: `System Administrator` (or a custom integration profile with API access)
3. Save — note the exact **Username** value, you'll need it in the next step

**Assign a Data Cloud permission set:**

The permission set name depends on your Salesforce edition. Common options:

| Edition | Permission Set to Assign |
|---|---|
| Data Cloud add-on | `Data Cloud Architect` or your permission set |

1. On the user record → **Permission Set Assignments** → **Edit Assignments**
2. Add whichever Data Cloud permission set is available in your org (check Setup → Permission Sets and filter by "Data Cloud" or "CDP")
3. Save

> If unsure which to use, assign the one your Data Cloud admin account already has — the integration user needs the same level of Data Cloud access.

---

### Step 3: Assign the Run-As User to the External Client App

1. External Client App Manager → your app → **Edit Policies**
2. Under **Client Credentials Flow**:
   - Run As: select the integration user created in Step 2
3. Under **OAuth Policies**:
   - IP Relaxation: `Relax IP restrictions`
4. Save

---

### Step 4: Create a Data Cloud Ingestion API Connector

1. Data Cloud Setup → **Ingestion API** → **New**
2. Choose a connector name — you'll use this exact value in the `ConnectorName` job parameter
3. Upload the schema file from `datacloud/product-ingestion-schema.yaml` in this repo
4. Create a Data Stream:
   - Object: `Product`
   - Primary Key: `product_id`
   - Category: `Other`
   - Record Modified Field: leave blank
5. Deploy the data stream

---

## Part 2: B2C Commerce Setup

### Step 1: Configure the Auth Service in Business Manager

The cartridge uses a single B2C Service for OAuth authentication. 

Create **Credentials** — go to **Operations → Services → Service Credentials** → Create credential (e.g. `int_datacloud.auth.cred`):

| Field | Value |
|---|---|
| Name | `int_datacloud.auth.cred` |
| URL | `https://yourorg.sandbox.my.salesforce.com` (Salesforce Core My Domain URL — do **not** use `lightning.force.com`) |
| Consumer Key | Consumer Key from the External Client App |
| Consumer Secret | Consumer Secret from the External Client App |

> Leave User, Password, and all other fields blank.

Create **Profile** — **BM → Administration → Operations → Services → Profile** — click New Profile:

| Field | Value |
|---|---|
| Name | `int_datacloud.auth.profile` |
| Timeout (ms) | `10000` |
| CB Enabled | ✅ |


Create it in **BM → Administration → Operations → Services → New Service**:

**Service:**

| Field | Value |
|---|---|
| Name | `int_datacloud.auth` |
| Type | `HTTP` |
| Enabled | ✅ |
| Log Name Prefix | `int_datacloud_auth` |
| Communication Log Enabled | ✅ |
| Profile | `int_datacloud.auth.profile` |
| Credentials | `int_datacloud.auth.cred` |


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

> Get the access key from: My User Profile -> Credentials → Manage Access Keys → WebDAV File Access and UX Studio → generate a new key.

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

| Parameter | Required | Example Value | Notes |
|---|---|---|---|
| `ConnectorName` | ✅ | `MyB2CConnector` | Case-sensitive, must match DC Setup |
| `JobConfig` | — | *(see below)* | Optional JSON — omit to use all defaults |

**Default behaviour (no `JobConfig` set):** Exports all online products from the full site catalog, skips offline and unnamed products, uploads in 800KB batches, authenticates via the `int_datacloud.auth` service, ingests into the `Product` object, and polls for up to 10 minutes. Debug logging is off.

**`JobConfig` options (all optional — omit any key to use the default):**

| Key | Default | Description |
|---|---|---|
| `onlineOnly` | `true` | Skip offline products |
| `inStockOnly` | `false` | Skip out-of-stock products |
| `catalogId` | `""` | Catalog ID to scope by category — leave blank to query all site products |
| `categoryId` | `"root"` | Category ID within the catalog (only used when `catalogId` is set) |
| `categoryRollup` | `true` | `true` = include all sub-categories; `false` = direct products only |
| `objectName` | `"Product"` | Data Cloud schema object name |
| `serviceId` | `"int_datacloud.auth"` | BM Service ID for OAuth |
| `batchSizeKB` | `800` | Batch flush threshold in KB (max ~900 to stay under 1MB quota) |
| `maxPollAttempts` | `120` | Max poll cycles × 5s = 10 min default |
| `enableDebugLogging` | `false` | Logs per-product detail and config at INFO level |

**Example — online + in-stock only, scoped to a category, debug on:**
```json
{"onlineOnly":true,"inStockOnly":true,"catalogId":"storefront-catalog-en","categoryId":"womens-shoes","categoryRollup":true,"enableDebugLogging":true}
```

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
  ├─ Step 1: Client Credentials POST to InstanceURL/services/oauth2/token
  │          client_id + client_secret from BM Service credential
  │          → Returns: Salesforce Core access_token + instance_url
  │
  ├─ Step 2: Token exchange POST to instance_url/services/a360/token
  │          grant_type=urn:salesforce:grant-type:external:cdp
  │          → Returns: Data Cloud access_token + instance_url (DC tenant)
  │
  └─ Step 3: Data Cloud Bulk Ingestion API using DC token
             POST {dc_instance_url}/api/v1/ingest/jobs
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
| `in_stock` | boolean | `product.getAvailabilityModel().isInStock()` |

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
- Rotate the B2C Access Key after sharing in any session
- Consumer Key goes in BM job parameters only, never in code