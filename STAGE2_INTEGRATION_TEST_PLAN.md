# Stage 2 Reseller / Multi-Tenant Integration Test Plan

This plan verifies Stage 2 reseller/client boundaries with seeded local or staging records only. Do not run this against production data.

## Seed Data

All seeded users use this password:

```text
Stage2Test!2026
```

Users:

| User | Email | Role | Expected Scope |
| --- | --- | --- | --- |
| Platform Admin | `platform.admin@stage2.test` | `platform_admin` | All resellers and client organizations |
| Reseller Admin A | `reseller.admin.a@stage2.test` | `reseller_admin` | Reseller A client organizations only |
| Reseller Admin B | `reseller.admin.b@stage2.test` | `reseller_admin` | Reseller B client organizations only |
| Client Admin A1 | `client.admin.a1@stage2.test` | `client_admin` | Client A1 only |
| Client Admin A2 | `client.admin.a2@stage2.test` | `client_admin` | Client A2 only |
| Client Admin B1 | `client.admin.b1@stage2.test` | `client_admin` | Client B1 only |
| Client User A1 | `client.user.a1@stage2.test` | `client_user` | Client A1 read-only portal access |
| Client User B1 | `client.user.b1@stage2.test` | `client_user` | Client B1 read-only portal access |

Resellers:

| Reseller | Assigned Admin | Client Organizations |
| --- | --- | --- |
| Stage2 Reseller A | Reseller Admin A | Stage2 Client A1, Stage2 Client A2 |
| Stage2 Reseller B | Reseller Admin B | Stage2 Client B1 |

Client organizations:

| Client | Reseller | Client Admin | Assigned Users | Seed Numbers |
| --- | --- | --- | --- | --- |
| Stage2 Client A1 | Reseller A | Client Admin A1 | Client Admin A1, Client User A1 | `+15550101001`, `+15550101002` |
| Stage2 Client A2 | Reseller A | Client Admin A2 | Client Admin A2 | `+15550102001` pending |
| Stage2 Client B1 | Reseller B | Client Admin B1 | Client Admin B1, Client User B1 | `+15550103001` |

## Seed Script

Prepare the database target first with [STAGE2_QA_MONGODB_SETUP.md](./STAGE2_QA_MONGODB_SETUP.md).

Run from `voip-system-backend` against a local or approved staging database:

```powershell
$env:STAGE2_SEED_CONFIRM='local-stage2-seed'
node scripts/seedStage2Tenants.js
```

Cleanup:

```powershell
$env:STAGE2_SEED_CONFIRM='local-stage2-seed'
node scripts/seedStage2Tenants.js --cleanup
```

The script refuses to run unless `STAGE2_SEED_CONFIRM=local-stage2-seed` is set. It also checks that `MONGO_URI` looks local, dev, test, or staging. For an approved staging URI that does not match those words, set `STAGE2_SEED_ALLOW_NON_LOCAL=true` only after confirming the target database.

For remote staging databases, the seed script prints a warning with the target URI host/database before writing. Stop immediately if that URI is not a dedicated Stage 2 QA/staging database.

## API Setup

Get tokens:

```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "platform.admin@stage2.test",
  "password": "Stage2Test!2026"
}
```

Repeat for each seeded user. Use the returned token as:

```http
Authorization: Bearer <token>
```

Record the client account IDs printed by the seed script:

```text
clientA1 = <printed id>
clientA2 = <printed id>
clientB1 = <printed id>
```

## Test Scenarios

### 1. Platform Admin Sees and Manages All

Requests:

```http
GET /api/admin-portal/client-accounts
GET /api/admin-portal/client-accounts/:clientA1/users
GET /api/admin-portal/client-accounts/:clientB1/users
POST /api/admin-portal/client-accounts/:clientA1/users
PUT /api/admin-portal/client-accounts/:clientB1/users/:userId
GET /api/admin-portal/client-accounts/:clientA1/numbers
GET /api/admin-portal/client-accounts/:clientB1/numbers
```

Expected result:

| Check | Expected |
| --- | --- |
| Can list all client organizations | Pass |
| Can manage users in A1, A2, and B1 | Pass |
| Can view/manage client numbers in A1, A2, and B1 | Pass |
| Existing legacy `admin` user still has platform-admin compatibility | Pass |

### 2. Reseller Admin A Is Limited to Reseller A

Requests using Reseller Admin A token:

```http
GET /api/reseller-portal/client-accounts
GET /api/reseller-portal/client-accounts/:clientA1
GET /api/reseller-portal/client-accounts/:clientA2
GET /api/reseller-portal/client-accounts/:clientB1
GET /api/reseller-portal/client-accounts/:clientA1/users
POST /api/reseller-portal/client-accounts/:clientA1/users
GET /api/reseller-portal/client-accounts/:clientB1/users
POST /api/reseller-portal/client-accounts/:clientB1/users
```

Expected result:

| Check | Expected |
| --- | --- |
| Sees A1 and A2 | Pass |
| Does not see B1 | Pass |
| Can manage A1/A2 users | Pass |
| Cannot view or manage B1 users by changing the URL ID | `403` |

### 3. Reseller Admin B Is Limited to Reseller B

Requests using Reseller Admin B token:

```http
GET /api/reseller-portal/client-accounts
GET /api/reseller-portal/client-accounts/:clientB1
GET /api/reseller-portal/client-accounts/:clientA1
POST /api/reseller-portal/client-accounts/:clientA1/users
```

Expected result:

| Check | Expected |
| --- | --- |
| Sees B1 | Pass |
| Does not see A1/A2 | Pass |
| Cannot manage A1/A2 users | `403` |

### 4. Client Admin A1 Is Limited to Client A1

Requests using Client Admin A1 token:

```http
GET /api/client-portal/summary
GET /api/client-portal/client-accounts/:clientA1
GET /api/client-portal/client-accounts/:clientA1/users
POST /api/client-portal/client-accounts/:clientA1/users
GET /api/client-portal/client-accounts/:clientA2
GET /api/client-portal/client-accounts/:clientB1
POST /api/client-portal/client-accounts/:clientB1/users
GET /api/client-portal/client-accounts/:clientA1/numbers
POST /api/client-portal/client-accounts/:clientA1/numbers
POST /api/client-portal/client-accounts/:clientB1/numbers
```

Expected result:

| Check | Expected |
| --- | --- |
| Can load own summary/details | Pass |
| Can manage own users and numbers | Pass |
| Cannot access A2 or B1 by changing IDs | `403` |
| Cannot manage B1 users or numbers | `403` |

### 5. Client User Has View-Only Access

Requests using Client User A1 token:

```http
GET /api/client-portal/summary
GET /api/client-portal/client-accounts/:clientA1/users
POST /api/client-portal/client-accounts/:clientA1/users
PUT /api/client-portal/client-accounts/:clientA1/users/:userId
DELETE /api/client-portal/client-accounts/:clientA1/users/:userId
POST /api/client-portal/client-accounts/:clientA1/numbers
```

Expected result:

| Check | Expected |
| --- | --- |
| Can view own organization summary/users if portal allows read access | Pass |
| Cannot add users | `403` |
| Cannot edit users | `403` |
| Cannot remove users | `403` |
| Cannot manage numbers | `403` |

### 6. Restricted Role Escalation Is Blocked

Requests using Reseller Admin A or Client Admin A1 token:

```http
POST /api/reseller-portal/client-accounts/:clientA1/users
{
  "name": "Bad Platform Admin",
  "email": "bad.platform@stage2.test",
  "password": "Stage2Test!2026",
  "role": "platform_admin"
}
```

```http
POST /api/client-portal/client-accounts/:clientA1/users
{
  "name": "Bad Reseller Admin",
  "email": "bad.reseller@stage2.test",
  "password": "Stage2Test!2026",
  "role": "reseller_admin"
}
```

Expected result:

| Check | Expected |
| --- | --- |
| Reseller admin cannot create `platform_admin` | `403` |
| Reseller admin cannot create `reseller_admin` | `403` |
| Client admin cannot create `platform_admin` | `403` |
| Client admin cannot create `reseller_admin` | `403` |
| Client admin cannot use `makeClientAdmin` to replace the primary admin | `403` |

### 7. Cross-Client User Assignment Is Blocked

Requests:

```http
POST /api/client-portal/client-accounts/:clientA1/users/:clientUserB1Id/assign
```

```http
POST /api/reseller-portal/client-accounts/:clientA1/users/:clientUserB1Id/assign
```

Expected result:

| Check | Expected |
| --- | --- |
| Client Admin A1 cannot assign Client User B1 | `403` |
| Reseller Admin A cannot assign Client User B1 to A1 | `403` |
| Reseller Admin B cannot assign Client User A1 to B1 | `403` |

### 8. Number Ownership Boundaries Are Enforced

Requests:

```http
GET /api/reseller-portal/client-accounts/:clientA1/numbers
GET /api/reseller-portal/client-accounts/:clientB1/numbers
POST /api/reseller-portal/client-accounts/:clientB1/numbers
GET /api/client-portal/client-accounts/:clientA1/numbers
GET /api/client-portal/client-accounts/:clientB1/numbers
POST /api/client-portal/client-accounts/:clientB1/numbers
```

Expected result:

| Check | Expected |
| --- | --- |
| Reseller Admin A can manage A1/A2 numbers | Pass |
| Reseller Admin A cannot manage B1 numbers | `403` |
| Client Admin A1 can manage A1 numbers | Pass |
| Client Admin A1 cannot manage B1 numbers | `403` |

### 9. Caller ID Options Are Scoped With Fallback

Requests:

```http
GET /api/calls/caller-ids
```

Expected result:

| User | Expected |
| --- | --- |
| Client Admin A1 | Active voice numbers for A1, including `+15550101001` and `+15550101002` |
| Client User A1 | Active voice numbers for A1, including `+15550101001` and `+15550101002` |
| Client Admin A2 | Fallback/default caller ID behavior if no active client-owned voice number exists |
| Legacy agent without `clientAccountId` | Existing fallback/default caller ID behavior |

### 10. Existing Production Modules Remain Unchanged

Smoke checks:

```http
POST /api/auth/login
GET /api/messages
GET /api/calls
GET /api/contacts
GET /api/dashboard
```

Expected result:

| Check | Expected |
| --- | --- |
| Login still works for existing users | Pass |
| Existing chat/message routes still resolve | Pass |
| Existing call routes still resolve | Pass |
| Existing contacts/dashboard still resolve | Pass |
| No Twilio webhook or routing behavior changes are required for this test | Pass |

## Manual UI Checks

Client Portal:

| Actor | Expected UI Behavior |
| --- | --- |
| Client Admin A1 | Sees A1 users and numbers; add/edit/remove controls visible |
| Client User A1 | Sees organization users if allowed; management controls hidden or rejected |
| Client Admin A1 with A2/B1 URL | Access denied or redirected |

Reseller Portal:

| Actor | Expected UI Behavior |
| --- | --- |
| Reseller Admin A | Sees A1/A2 only; can select clients and manage scoped users/numbers |
| Reseller Admin B | Sees B1 only |
| Reseller Admin A with B1 URL | Access denied |

Admin Portal:

| Actor | Expected UI Behavior |
| --- | --- |
| Platform Admin | Sees all reseller/client organizations and scoped users/numbers |

## Missing Tools For Full Automation

To fully automate this plan, add:

- A test runner such as Jest, Vitest, or Node's built-in test runner.
- A disposable MongoDB test database or MongoDB Memory Server.
- Supertest or equivalent HTTP integration test client.
- A test-only JWT helper or scripted login helper.
- CI environment variables for test database URI and JWT secret.

Until those are added, this plan can be executed with Postman, Insomnia, curl, or PowerShell `Invoke-RestMethod` against a local/staging server.
