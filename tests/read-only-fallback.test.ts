import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

test("read-only clone uses canonical trusted creator addresses without relay keys", () => {
  const env = { ...process.env }
  for (const name of ["ARKIV_ACCESS_KEY", "DESK_KEY", "LEGAL_AID_KEY", "DESK_ADDRESS", "LEGAL_AID_ADDRESS"])
    delete env[name]
  const child = spawnSync(process.execPath, [
    "--import", "tsx", "--input-type=module", "-e",
    'const { DESK, LEGAL_AID, deskWallet, legalWallet } = await import("./server/arkiv.ts"); console.log(JSON.stringify({ DESK, LEGAL_AID, writesEnabled: Boolean(deskWallet && legalWallet) }))',
  ], { cwd: process.cwd(), env, encoding: "utf8" })

  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), {
    DESK: "0x849C3840754cf21B0ec45BA359cCcde1F8ECEBd2",
    LEGAL_AID: "0xb114Ab157311e6C15B74fb08789632671d45D9c2",
    writesEnabled: false,
  })
})
