import { copyFile, link, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { Email, Password } from '@familycloud/shared/all';
import { eq } from 'drizzle-orm';
import { loadConfig } from './config';
import { createContext, ensureSetupToken } from './context';
import { users } from './db/schema';
import { reconcileUsage } from './jobs/maintenance';
import { MemoryQueue } from './jobs/queue';
import { randomToken } from './lib/crypto';
import { hashPassword } from './lib/passwords';
import { createUserWithRoot } from './modules/auth/service';
import { listTree } from './modules/files/serve';

const HELP = `Family Cloud admin CLI

Usage: cli <command> [options]

Commands:
  setup-token                    Print the first-run setup token (only before an admin exists)
  create-admin --email E --name N
                                 Create an admin account (prompts for a password)
  reset-password --email E       Set a new random password and print it once
  reset-totp --email E           Turn off two-factor for a user who lost their phone
  reconcile                      Recalculate every user's storage usage
  export --out DIR [--email E]   Rebuild normal folders from the blob store (disaster recovery).
                                 Hard-links when on the same disk, copies otherwise.
  migrate                        Apply database migrations and exit
`;

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      out: { type: 'string' },
    },
    allowPositionals: true,
  });
  if (!command || command === 'help' || command === '--help') {
    stdout.write(HELP);
    return;
  }

  const config = loadConfig();
  const ctx = await createContext(config, { role: 'cli', jobs: new MemoryQueue() });
  try {
    switch (command) {
      case 'migrate':
        stdout.write('Migrations applied.\n');
        break;

      case 'setup-token': {
        const token = await ensureSetupToken(ctx);
        stdout.write(token ? `${token}\n` : 'Setup is complete (an account already exists).\n');
        break;
      }

      case 'create-admin': {
        const email = Email.parse(values.email);
        const name = values.name ?? email.split('@')[0]!;
        const password = Password.parse(
          process.env.FC_PASSWORD ?? (await prompt('Password (10+ chars): ')),
        );
        const passwordHash = await hashPassword(password);
        await ctx.db.transaction((tx) =>
          createUserWithRoot(tx, {
            email,
            displayName: name,
            passwordHash,
            role: 'admin',
            quotaBytes: null,
          }),
        );
        await ctx.settings.setRaw('setupToken', null);
        stdout.write(`Created admin ${email}\n`);
        break;
      }

      case 'reset-password': {
        const email = Email.parse(values.email);
        const password = randomToken(12);
        const rows = await ctx.db
          .update(users)
          .set({ passwordHash: await hashPassword(password), failedLogins: 0, lockedUntil: null })
          .where(eq(users.email, email))
          .returning({ id: users.id });
        if (!rows[0]) throw new Error(`No user ${email}`);
        await ctx.sessions.revokeAll(ctx.db, rows[0].id);
        stdout.write(
          `New password for ${email}: ${password}\nAsk them to change it in Settings.\n`,
        );
        break;
      }

      case 'reset-totp': {
        const email = Email.parse(values.email);
        const rows = await ctx.db
          .update(users)
          .set({ totpEnabled: false, totpSecretEnc: null, totpLastStep: null })
          .where(eq(users.email, email))
          .returning({ id: users.id });
        if (!rows[0]) throw new Error(`No user ${email}`);
        stdout.write(`Two-factor turned off for ${email}.\n`);
        break;
      }

      case 'reconcile': {
        const drift = await reconcileUsage(ctx);
        stdout.write(
          drift.length ? `Corrected ${drift.length} user(s).\n` : 'Usage already correct.\n',
        );
        break;
      }

      case 'export': {
        if (!values.out) throw new Error('--out is required');
        const out = path.resolve(values.out);
        const people = await ctx.db
          .select()
          .from(users)
          .where(values.email ? eq(users.email, Email.parse(values.email)) : undefined);
        let files = 0;
        for (const person of people) {
          if (!person.rootNodeId) continue;
          const base = path.join(out, person.email);
          await mkdir(base, { recursive: true });
          for (const entry of await listTree(ctx.db, person.rootNodeId, 10_000_000)) {
            const dest = path.join(base, entry.path);
            if (!dest.startsWith(base + path.sep)) continue; // defensive: names never contain separators
            if (entry.type === 'folder') {
              await mkdir(dest, { recursive: true });
              continue;
            }
            if (!entry.blobId || !entry.volumeId) continue;
            await mkdir(path.dirname(dest), { recursive: true });
            const src = await ctx.volumes.blobFile({ id: entry.blobId, volumeId: entry.volumeId });
            await link(src, dest).catch(() => copyFile(src, dest));
            files++;
          }
        }
        stdout.write(`Exported ${files} files to ${out}\n`);
        break;
      }

      default:
        stdout.write(`Unknown command: ${command}\n\n${HELP}`);
        process.exitCode = 1;
    }
  } finally {
    await ctx.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
