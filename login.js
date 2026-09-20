/**
 * Login Script - Jalankan sekali untuk generate session
 * Usage: node login.js
 */
require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const readline = require('readline');
const fs = require('fs');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

async function main() {
    console.log('\n╔══════════════════════════════╗');
    console.log('║   🔐 TELEGRAM LOGIN HELPER   ║');
    console.log('╚══════════════════════════════╝\n');

    const apiId = parseInt(process.env.API_ID) || parseInt(await ask('API ID (dari my.telegram.org): '));
    const apiHash = process.env.API_HASH || await ask('API Hash (dari my.telegram.org): ');

    if (!apiId || !apiHash) {
        console.error('❌ API ID atau API Hash tidak boleh kosong!');
        process.exit(1);
    }

    console.log('\n📱 Memulai proses login...\n');

    const client = new TelegramClient(
        new StringSession(''),
        apiId,
        apiHash,
        { connectionRetries: 5 }
    );

    await client.start({
        phoneNumber: async () => {
            const phone = await ask('📞 Nomor HP (+628xxx): ');
            return phone.trim();
        },
        password: async () => {
            const pwd = await ask('🔑 Password 2FA (Enter jika tidak ada): ');
            return pwd.trim();
        },
        phoneCode: async () => {
            const code = await ask('📩 Kode OTP dari Telegram: ');
            return code.trim();
        },
        onError: (err) => console.error('❌ Error login:', err.message)
    });

    const me = await client.getMe();
    const session = client.session.save();

    fs.writeFileSync('session.txt', session, 'utf8');
    console.log('\n╔══════════════════════════════════╗');
    console.log('║   ✅ LOGIN BERHASIL!             ║');
    console.log('╠══════════════════════════════════╣');
    console.log(`║  Nama  : ${(me.firstName || '').padEnd(22)}║`);
    console.log(`║  User  : @${(me.username || '-').padEnd(21)}║`);
    console.log('╠══════════════════════════════════╣');
    console.log('║  Session disimpan ke session.txt ║');
    console.log('║  Jalankan: node index.js         ║');
    console.log('╚══════════════════════════════════╝\n');

    rl.close();
    await client.disconnect();
}

main().catch(e => {
    console.error('Fatal error:', e.message);
    rl.close();
    process.exit(1);
});
