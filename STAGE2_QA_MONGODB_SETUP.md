# Stage 2 QA MongoDB Setup

Use this guide to prepare a safe MongoDB target for Stage 2 reseller and multi-tenant QA. Do not use the production MongoDB database.

## Goal

Create a separate MongoDB database for seeded Stage 2 QA records, then run the Stage 2 seed script and integration test plan against that database.

Recommended database names:

- `voip_stage2_qa`
- `voip_staging_stage2`
- `voip_dev_stage2`

## Safety Checklist Before Seeding

Confirm all items before running the seed script:

| Check | Required |
| --- | --- |
| The MongoDB cluster is not the production cluster | Yes |
| The database name includes `stage`, `staging`, `test`, `qa`, or `dev` | Yes |
| The URI points to a dedicated QA/staging database, not the production app database | Yes |
| The database can be deleted or cleaned up after QA | Yes |
| The seed users use `@stage2.test` emails only | Yes |
| No real Twilio numbers are required | Yes |
| No production `.env` file is overwritten | Yes |

If any item is uncertain, stop and create a new isolated staging database first.

## MongoDB Atlas Staging/Test Option

1. Create or open a non-production MongoDB Atlas project.
2. Create a new cluster or use an existing staging cluster.
3. Create a database user with access only to the Stage 2 QA database if possible.
4. Add your current IP address to the Atlas network access allowlist.
5. Create a database named one of:

```text
voip_stage2_qa
voip_staging_stage2
voip_dev_stage2
```

6. Copy the connection string and ensure the database name appears at the end of the URI.

Example:

```text
mongodb+srv://<user>:<password>@<cluster-host>/voip_stage2_qa?retryWrites=true&w=majority
```

## Environment Variables

PowerShell local/staging database:

```powershell
$env:MONGO_URI='mongodb://127.0.0.1:27017/voip_stage2_qa'
$env:STAGE2_SEED_CONFIRM='local-stage2-seed'
```

PowerShell MongoDB Atlas staging/test database:

```powershell
$env:MONGO_URI='mongodb+srv://<user>:<password>@<cluster-host>/voip_stage2_qa?retryWrites=true&w=majority'
$env:STAGE2_SEED_CONFIRM='local-stage2-seed'
$env:STAGE2_SEED_ALLOW_NON_LOCAL='true'
```

Only set `STAGE2_SEED_ALLOW_NON_LOCAL=true` after confirming the URI is a dedicated staging/test database. This variable is intentionally required for remote URIs that do not look local.

## Run Seed

From `voip-system-backend`:

```powershell
node scripts/seedStage2Tenants.js
```

Expected output includes:

- Seeded user emails
- Reseller IDs
- Client account IDs
- Seed phone numbers
- Reminder that seeded phone numbers do not connect to live Twilio routing

Save the printed client account IDs for API testing:

```text
clientA1 = <printed id>
clientA2 = <printed id>
clientB1 = <printed id>
```

## Run Cleanup

From `voip-system-backend`, using the same `MONGO_URI`:

```powershell
node scripts/seedStage2Tenants.js --cleanup
```

Cleanup removes only the known Stage 2 seed records:

- `@stage2.test` seed users
- `Stage2 Reseller A`
- `Stage2 Reseller B`
- `Stage2 Client A1`
- `Stage2 Client A2`
- `Stage2 Client B1`
- Seed test numbers beginning with `+1555010`

## QA Tests After Seeding

Run the tests in [STAGE2_INTEGRATION_TEST_PLAN.md](./STAGE2_INTEGRATION_TEST_PLAN.md), including:

| Area | What To Verify |
| --- | --- |
| Platform admin | Can view/manage all reseller and client organizations |
| Reseller admin A | Can manage only Reseller A clients |
| Reseller admin B | Can manage only Reseller B clients |
| Client admin A1/A2/B1 | Can manage only their own organization |
| Client user | Can view allowed organization data but cannot manage users/numbers |
| Cross-client access | URL/API ID changes return `403` |
| Cross-reseller access | Other reseller clients return `403` |
| Restricted roles | Reseller/client admins cannot create `platform_admin` or `reseller_admin` |
| Number ownership | Portal number APIs stay scoped to the correct client/reseller |
| Caller ID | Active client voice numbers appear when available, otherwise fallback still works |

## Do Not Use This Setup For

- Production migrations
- Tenant enforcement changes
- Twilio number purchasing or porting
- Live call routing
- Live SMS/MMS routing
- Production dashboard validation

This setup is only for Stage 2 reseller/client boundary QA.
