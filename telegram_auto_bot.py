import asyncio
import json
import logging
import os
import random
from datetime import datetime, timezone, timedelta
from pyrogram import Client, filters
from pyrogram.errors import FloodWait, RPCError

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("Userbot")

# =====================================================================
# ⚙️ KONFIGURASI AKUN TELEGRAM
# Silakan isi API ID, API HASH, dan Nomor HP Anda di bawah ini
# =====================================================================
API_ID = int(os.environ.get("API_ID", "0"))
API_HASH = os.environ.get("API_HASH", "")
PHONE_NUMBER = os.environ.get("PHONE_NUMBER", "")

CONFIG_FILE = "bot_config.json"
REPLY_COMMANDS = [
    "/sharemsg",
    "/sharemsg2",
    "/sharemsg3",
    "/broadcast",
    "/broadcast2",
    "/broadcast3"
]
REPLY_INTERVAL = 60        # Jeda antar reply (detik)
MIN_CYCLE_WAIT = 20 * 60   # Jeda siklus minimal (20 menit)
MAX_CYCLE_WAIT = 25 * 60   # Jeda siklus maksimal (25 menit)

WIB = timezone(timedelta(hours=7))
NIGHT_START_HOUR = 0
NIGHT_END_HOUR = 3


def is_night_time():
    now_wib = datetime.now(WIB)
    return NIGHT_START_HOUR <= now_wib.hour < NIGHT_END_HOUR


def load_config():
    default_config = {
        "main_message": "",
        "main_messages": [],
        "forward_messages": [],
        "current_msg_index": 0,
        "target_groups": [],
        "is_auto_active": False
    }
    if not os.path.exists(CONFIG_FILE):
        save_config(default_config)
        return default_config
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            if "main_messages" not in data or not isinstance(data["main_messages"], list):
                old_msg = data.get("main_message", "")
                data["main_messages"] = [old_msg] if old_msg else []
            if "current_msg_index" not in data:
                data["current_msg_index"] = 0
            if "forward_messages" not in data:
                data["forward_messages"] = []
            return data
    except Exception as e:
        logger.error(f"Gagal membaca config: {e}")
        return default_config


def save_config(data):
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=4, ensure_ascii=False)
    except Exception as e:
        logger.error(f"Gagal menyimpan config: {e}")


config_data = load_config()

app = Client(
    name="my_userbot",
    api_id=API_ID,
    api_hash=API_HASH,
    phone_number=PHONE_NUMBER
)


def build_combined_pool():
    """Gabungkan main_messages (teks) dan forward_messages menjadi satu pool rotasi."""
    pool = []
    for msg in config_data.get("main_messages", []):
        pool.append({"type": "text", "content": msg})
    for fw in config_data.get("forward_messages", []):
        pool.append({"type": "forward", "content": fw})
    return pool


async def auto_post_loop():
    await asyncio.sleep(5)
    while True:
        try:
            if is_night_time():
                now_str = datetime.now(WIB).strftime("%H:%M:%S")
                logger.info(f"🌙 [{now_str} WIB] Jam tidur (00:00–03:00). Bot diistirahatkan...")
                await asyncio.sleep(60)
                continue

            if config_data.get("is_auto_active"):
                target_groups = config_data.get("target_groups", [])
                combined_pool = build_combined_pool()

                if not combined_pool:
                    logger.warning("⚠️ Auto aktif tapi belum ada pesan. Gunakan /addpesan atau /addpesanfw.")
                elif not target_groups:
                    logger.warning("⚠️ Auto aktif tapi belum ada grup target. Gunakan /addgb di dalam grup.")
                else:
                    msg_idx = config_data.get("current_msg_index", 0) % len(combined_pool)
                    current_item = combined_pool[msg_idx]
                    item_label = "Teks" if current_item["type"] == "text" else f"Forward: {current_item['content'].get('label', '')}"

                    now_str = datetime.now(WIB).strftime("%H:%M:%S")
                    logger.info(f"🚀 [{now_str} WIB] Siklus #{msg_idx + 1}/{len(combined_pool)} ({item_label}) → {len(target_groups)} grup")

                    try:
                        async for _ in app.get_dialogs():
                            pass
                    except Exception as cache_err:
                        logger.warning(f"Cache gagal diperbarui: {cache_err}")

                    for chat_id in list(target_groups):
                        if not config_data.get("is_auto_active") or is_night_time():
                            logger.info("⏹️ Auto dihentikan atau masuk jam tidur.")
                            break

                        try:
                            sent_message = None

                            if current_item["type"] == "text":
                                main_msg = current_item["content"]
                                try:
                                    sent_message = await app.send_message(chat_id=chat_id, text=main_msg)
                                except (ValueError, KeyError):
                                    await app.get_chat(chat_id)
                                    sent_message = await app.send_message(chat_id=chat_id, text=main_msg)
                                logger.info(f"✅ Pesan teks #{msg_idx + 1} terkirim ke {chat_id}")

                            elif current_item["type"] == "forward":
                                fw_data = current_item["content"]
                                saved_chat = fw_data["saved_chat_id"]
                                saved_msg_id = fw_data["saved_message_id"]
                                try:
                                    results = await app.forward_messages(
                                        chat_id=chat_id,
                                        from_chat_id=saved_chat,
                                        message_ids=saved_msg_id
                                    )
                                    sent_message = results[0] if isinstance(results, list) else results
                                except (ValueError, KeyError):
                                    await app.get_chat(chat_id)
                                    results = await app.forward_messages(
                                        chat_id=chat_id,
                                        from_chat_id=saved_chat,
                                        message_ids=saved_msg_id
                                    )
                                    sent_message = results[0] if isinstance(results, list) else results
                                label = fw_data.get("label", f"FW #{msg_idx + 1}")
                                logger.info(f"✅ Forward '{label}' berhasil dikirim ke {chat_id}")

                            if sent_message:
                                for reply_text in REPLY_COMMANDS:
                                    if not config_data.get("is_auto_active") or is_night_time():
                                        break
                                    logger.info(f"⏳ Menunggu {REPLY_INTERVAL}s sebelum reply '{reply_text}'...")
                                    await asyncio.sleep(REPLY_INTERVAL)
                                    try:
                                        await app.send_message(
                                            chat_id=chat_id,
                                            text=reply_text,
                                            reply_to_message_id=sent_message.id
                                        )
                                        logger.info(f"💬 Reply '{reply_text}' → {chat_id}")
                                    except FloodWait as fw:
                                        logger.warning(f"⚠️ FloodWait {fw.value}s!")
                                        await asyncio.sleep(fw.value + 2)
                                        await app.send_message(
                                            chat_id=chat_id,
                                            text=reply_text,
                                            reply_to_message_id=sent_message.id
                                        )
                                    except Exception as err:
                                        logger.error(f"❌ Gagal reply '{reply_text}' di {chat_id}: {err}")

                        except FloodWait as fw:
                            logger.warning(f"⚠️ FloodWait pesan utama di {chat_id}! Tunggu {fw.value}s...")
                            await asyncio.sleep(fw.value + 5)
                        except RPCError as rpc_err:
                            logger.error(f"❌ RPC Error di {chat_id}: {rpc_err}")
                        except Exception as e:
                            logger.error(f"❌ Gagal kirim ke {chat_id}: {e}")

                    next_idx = (msg_idx + 1) % len(combined_pool)
                    config_data["current_msg_index"] = next_idx
                    save_config(config_data)
                    logger.info(f"🔄 Siklus selesai! Giliran berikutnya: #{next_idx + 1}")

            sleep_dur = random.randint(MIN_CYCLE_WAIT, MAX_CYCLE_WAIT)
            logger.info(f"💤 Menunggu {round(sleep_dur / 60, 1)} menit untuk siklus berikutnya...")
            await asyncio.sleep(sleep_dur)

        except asyncio.CancelledError:
            logger.info("Task posting dihentikan.")
            break
        except Exception as global_err:
            logger.error(f"Error tak terduga: {global_err}")
            await asyncio.sleep(60)


# ══════════════════════════════════════════════════════════════
# HANDLER PESAN TEKS
# ══════════════════════════════════════════════════════════════

@app.on_message(filters.me & filters.command("addpesan", prefixes="/"))
async def handle_addpesan(client, message):
    """Menambahkan pesan teks baru ke rotasi."""
    parts = message.text.split(maxsplit=1)
    if len(parts) < 2:
        await message.edit_text(
            "╔══ ⚠️ FORMAT SALAH ══╗\n\n"
            "📌 Cara pakai:\n"
            "`/addpesan <teks pesan>`\n\n"
            "📝 Contoh:\n"
            "`/addpesan Halo! Promo ready stok variasi 2!`\n\n"
            "╚══════════════════╝"
        )
        return

    new_msg = parts[1]
    msgs = config_data.get("main_messages", [])
    msgs.append(new_msg)
    config_data["main_messages"] = msgs
    save_config(config_data)

    preview = new_msg[:100] + "..." if len(new_msg) > 100 else new_msg
    await message.edit_text(
        f"╔══ ✅ PESAN #{len(msgs)} DITAMBAHKAN ══╗\n\n"
        f"📝 **Isi:**\n{preview}\n\n"
        f"📊 Total pesan teks: `{len(msgs)}`\n\n"
        "╚════════════════════════╝"
    )


@app.on_message(filters.me & filters.command("delpesan", prefixes="/"))
async def handle_delpesan(client, message):
    """Menghapus pesan teks berdasarkan nomor."""
    parts = message.text.split(maxsplit=1)
    msgs = config_data.get("main_messages", [])

    if len(parts) < 2 or not parts[1].isdigit():
        await message.edit_text(
            "╔══ ⚠️ FORMAT SALAH ══╗\n\n"
            "📌 Cara pakai: `/delpesan <nomor>`\n"
            "📋 Cek daftar: `/listpesan`\n\n"
            "╚══════════════════╝"
        )
        return

    idx = int(parts[1]) - 1
    if idx < 0 or idx >= len(msgs):
        await message.edit_text(
            f"╔══ ❌ TIDAK DITEMUKAN ══╗\n\n"
            f"Nomor `{parts[1]}` tidak ada.\n"
            "Cek via `/listpesan`.\n\n"
            "╚══════════════════════╝"
        )
        return

    removed = msgs.pop(idx)
    config_data["main_messages"] = msgs
    if config_data.get("current_msg_index", 0) >= len(msgs):
        config_data["current_msg_index"] = 0
    save_config(config_data)

    preview = removed[:80] + "..." if len(removed) > 80 else removed
    await message.edit_text(
        f"╔══ 🗑️ PESAN #{idx + 1} DIHAPUS ══╗\n\n"
        f"📝 **Dihapus:**\n{preview}\n\n"
        f"📊 Sisa: `{len(msgs)}` pesan\n\n"
        "╚════════════════════╝"
    )


@app.on_message(filters.me & filters.command("listpesan", prefixes="/"))
async def handle_listpesan(client, message):
    """Menampilkan semua pesan teks dalam rotasi."""
    msgs = config_data.get("main_messages", [])
    if not msgs:
        await message.edit_text(
            "╔══ 📭 KOSONG ══╗\n\n"
            "Belum ada pesan teks.\n"
            "Gunakan `/addpesan <teks>` untuk tambah.\n\n"
            "╚══════════════╝"
        )
        return

    pool = build_combined_pool()
    curr_idx = config_data.get("current_msg_index", 0) % max(1, len(pool))

    res = "╔══ 📋 DAFTAR PESAN TEKS ══╗\n\n"
    for i, msg in enumerate(msgs):
        is_next = (i == curr_idx)
        tag = " 👈 *(Berikutnya)*" if is_next else ""
        preview = msg[:70] + "..." if len(msg) > 70 else msg
        res += f"**{i + 1}.** {preview}{tag}\n\n"

    res += f"📊 Total: `{len(msgs)}` pesan teks\n"
    res += "╚══════════════════════╝"
    await message.edit_text(res)


@app.on_message(filters.me & filters.command("setpesan", prefixes="/"))
async def handle_setpesan(client, message):
    """Reset dan set ulang pesan teks ke-1."""
    parts = message.text.split(maxsplit=1)
    if len(parts) < 2:
        await message.edit_text(
            "╔══ ⚠️ FORMAT SALAH ══╗\n\n"
            "📌 Cara pakai: `/setpesan <teks>`\n"
            "💡 Gunakan `/addpesan` untuk tambah variasi\n\n"
            "╚══════════════════╝"
        )
        return

    config_data["main_messages"] = [parts[1]]
    config_data["current_msg_index"] = 0
    save_config(config_data)

    await message.edit_text(
        "╔══ ✅ PESAN UTAMA DI-SET ══╗\n\n"
        f"📝 **Pesan #1:**\n{parts[1]}\n\n"
        "💡 Gunakan `/addpesan` untuk tambah variasi\n\n"
        "╚══════════════════════╝"
    )


# ══════════════════════════════════════════════════════════════
# HANDLER PESAN FORWARD
# ══════════════════════════════════════════════════════════════

@app.on_message(filters.me & filters.command("addpesanfw", prefixes="/"))
async def handle_addpesanfw(client, message):
    """Menyimpan pesan forward — harus di-reply ke pesan yang sudah di-forward."""
    if not message.reply_to_message:
        await message.edit_text(
            "╔══ ℹ️ CARA PAKAI /addpesanfw ══╗\n\n"
            "**Langkah-langkah:**\n"
            "1️⃣ Forward pesan dari channel/bot ke chat ini\n"
            "2️⃣ Reply (balas) ke pesan forward tersebut\n"
            "3️⃣ Ketik `/addpesanfw [label opsional]`\n\n"
            "📌 **Contoh:**\n"
            "`/addpesanfw Promo Channel Utama`\n\n"
            "╚══════════════════════════╝"
        )
        return

    reply = message.reply_to_message

    if not reply.forward_from_chat and not reply.forward_sender_name:
        await message.edit_text(
            "╔══ ❌ BUKAN PESAN FORWARD ══╗\n\n"
            "Pesan yang di-reply bukan **forward**!\n\n"
            "📌 Forward dulu pesan dari channel lain,\n"
            "lalu reply dengan `/addpesanfw`.\n\n"
            "╚══════════════════════════╝"
        )
        return

    parts = message.text.split(maxsplit=1)
    fw_list = config_data.get("forward_messages", [])
    label = parts[1] if len(parts) > 1 else f"Pesan Forward #{len(fw_list) + 1}"

    from_chat_name = "Unknown"
    from_chat_id = reply.chat.id
    if reply.forward_from_chat:
        from_chat_name = reply.forward_from_chat.title or str(reply.forward_from_chat.id)
        from_chat_id = reply.forward_from_chat.id

    fw_entry = {
        "label": label,
        "saved_chat_id": reply.chat.id,
        "saved_message_id": reply.id,
        "from_chat_id": from_chat_id,
        "from_chat_name": from_chat_name,
        "forward_from_message_id": reply.forward_from_message_id
    }

    fw_list.append(fw_entry)
    config_data["forward_messages"] = fw_list
    save_config(config_data)

    await message.edit_text(
        f"╔══ ✅ PESAN FORWARD #{len(fw_list)} DISIMPAN ══╗\n\n"
        f"🏷️ **Label:** `{label}`\n"
        f"📡 **Dari:** `{from_chat_name}`\n"
        f"💾 **Tersimpan di:** msg `{reply.id}` chat `{reply.chat.id}`\n\n"
        f"📊 Total pesan forward: `{len(fw_list)}`\n\n"
        "╚══════════════════════════════╝"
    )


@app.on_message(filters.me & filters.command("listpesanfw", prefixes="/"))
async def handle_listpesanfw(client, message):
    """Menampilkan semua pesan forward tersimpan."""
    fw_list = config_data.get("forward_messages", [])
    if not fw_list:
        await message.edit_text(
            "╔══ 📭 KOSONG ══╗\n\n"
            "Belum ada pesan forward.\n\n"
            "📌 Cara tambah:\n"
            "1. Forward pesan ke sini\n"
            "2. Reply dengan `/addpesanfw [label]`\n\n"
            "╚══════════════╝"
        )
        return

    pool = build_combined_pool()
    main_count = len(config_data.get("main_messages", []))
    curr_idx = config_data.get("current_msg_index", 0) % max(1, len(pool))

    res = "╔══ 📋 DAFTAR PESAN FORWARD ══╗\n\n"
    for i, fw in enumerate(fw_list):
        pool_pos = main_count + i
        is_next = (pool_pos == curr_idx)
        tag = " 👈 *(Berikutnya)*" if is_next else ""
        label = fw.get("label", f"Forward #{i + 1}")
        origin = fw.get("from_chat_name", "Unknown")
        res += f"**{i + 1}.** 🏷️ `{label}`{tag}\n"
        res += f"    📡 Dari: `{origin}`\n\n"

    res += f"📊 Total: `{len(fw_list)}` pesan forward\n"
    res += "╚══════════════════════════╝"
    await message.edit_text(res)


@app.on_message(filters.me & filters.command("delpesanfw", prefixes="/"))
async def handle_delpesanfw(client, message):
    """Menghapus pesan forward berdasarkan nomor."""
    parts = message.text.split(maxsplit=1)
    fw_list = config_data.get("forward_messages", [])

    if len(parts) < 2 or not parts[1].isdigit():
        await message.edit_text(
            "╔══ ⚠️ FORMAT SALAH ══╗\n\n"
            "📌 Cara pakai: `/delpesanfw <nomor>`\n"
            "📋 Cek daftar: `/listpesanfw`\n\n"
            "╚══════════════════╝"
        )
        return

    idx = int(parts[1]) - 1
    if idx < 0 or idx >= len(fw_list):
        await message.edit_text(
            f"╔══ ❌ TIDAK DITEMUKAN ══╗\n\n"
            f"Nomor `{parts[1]}` tidak ada.\n"
            "Cek via `/listpesanfw`.\n\n"
            "╚══════════════════════╝"
        )
        return

    removed = fw_list.pop(idx)
    config_data["forward_messages"] = fw_list
    total_pool = len(config_data.get("main_messages", [])) + len(fw_list)
    if config_data.get("current_msg_index", 0) >= max(1, total_pool):
        config_data["current_msg_index"] = 0
    save_config(config_data)

    label = removed.get("label", f"Forward #{idx + 1}")
    await message.edit_text(
        "╔══ 🗑️ PESAN FORWARD DIHAPUS ══╗\n\n"
        f"🏷️ **Dihapus:** `{label}`\n\n"
        f"📊 Sisa: `{len(fw_list)}` pesan forward\n\n"
        "╚══════════════════════════╝"
    )


# ══════════════════════════════════════════════════════════════
# HANDLER GRUP TARGET
# ══════════════════════════════════════════════════════════════

@app.on_message(filters.me & filters.command("addgb", prefixes="/"))
async def handle_addgb(client, message):
    """Menambahkan grup saat ini ke daftar target."""
    chat_id = message.chat.id
    title = message.chat.title or "Grup Tanpa Nama"

    if message.chat.type.value not in ["group", "supergroup"]:
        await message.edit_text(
            "╔══ ❌ BUKAN GRUP ══╗\n\n"
            "Perintah `/addgb` hanya bisa\ndigunakan di dalam **Grup**.\n\n"
            "╚══════════════════╝"
        )
        return

    groups = config_data.get("target_groups", [])
    if chat_id in groups:
        await message.edit_text(
            "╔══ ℹ️ SUDAH TERDAFTAR ══╗\n\n"
            f"**{title}**\n`{chat_id}`\n\n"
            "Grup ini sudah ada di daftar.\n\n"
            "╚══════════════════════╝"
        )
    else:
        groups.append(chat_id)
        config_data["target_groups"] = groups
        save_config(config_data)
        await message.edit_text(
            "╔══ ✅ GRUP DITAMBAHKAN ══╗\n\n"
            f"📌 **Nama:** {title}\n"
            f"🆔 **ID:** `{chat_id}`\n\n"
            f"📊 Total grup: `{len(groups)}`\n\n"
            "╚══════════════════════╝"
        )


@app.on_message(filters.me & filters.command("delgb", prefixes="/"))
async def handle_delgb(client, message):
    """Menghapus grup saat ini dari daftar target."""
    chat_id = message.chat.id
    title = message.chat.title or "Grup Tanpa Nama"

    groups = config_data.get("target_groups", [])
    if chat_id in groups:
        groups.remove(chat_id)
        config_data["target_groups"] = groups
        save_config(config_data)
        await message.edit_text(
            "╔══ 🗑️ GRUP DIHAPUS ══╗\n\n"
            f"**{title}** berhasil dihapus\ndari daftar target.\n\n"
            f"📊 Sisa: `{len(groups)}` grup\n\n"
            "╚══════════════════╝"
        )
    else:
        await message.edit_text(
            "╔══ ℹ️ TIDAK TERDAFTAR ══╗\n\n"
            f"**{title}** tidak ada di daftar.\n\n"
            "╚══════════════════════╝"
        )


@app.on_message(filters.me & filters.command("listgb", prefixes="/"))
async def handle_listgb(client, message):
    """Menampilkan semua grup target."""
    groups = config_data.get("target_groups", [])
    if not groups:
        await message.edit_text(
            "╔══ 📭 KOSONG ══╗\n\n"
            "Belum ada grup target.\n"
            "Gunakan `/addgb` di dalam grup.\n\n"
            "╚══════════════╝"
        )
        return

    res = "╔══ 📋 DAFTAR GRUP TARGET ══╗\n\n"
    for i, gid in enumerate(groups, 1):
        try:
            info = await client.get_chat(gid)
            res += f"**{i}.** {info.title}\n`{gid}`\n\n"
        except Exception:
            res += f"**{i}.** `{gid}` *(tidak dapat diakses)*\n\n"

    res += f"📊 Total: `{len(groups)}` grup\n"
    res += "╚══════════════════════╝"
    await message.edit_text(res)


# ══════════════════════════════════════════════════════════════
# HANDLER KONTROL BOT
# ══════════════════════════════════════════════════════════════

@app.on_message(filters.me & filters.command("auto", prefixes="/"))
async def handle_auto(client, message):
    """Mengaktifkan atau mematikan auto post."""
    args = message.text.split(maxsplit=1)
    if len(args) < 2:
        st = "🟢 **AKTIF**" if config_data.get("is_auto_active") else "🔴 **NON-AKTIF**"
        await message.edit_text(
            "╔══ 🤖 AUTO POST ══╗\n\n"
            f"Status: {st}\n\n"
            "`/auto on`  → aktifkan\n"
            "`/auto off` → matikan\n\n"
            "╚══════════════════╝"
        )
        return

    mode = args[1].lower()
    if mode == "on":
        config_data["is_auto_active"] = True
        save_config(config_data)
        await message.edit_text(
            "╔══ 🟢 AUTO POST AKTIF ══╗\n\n"
            "✅ Posting & reply otomatis\nberhasil **DIAKTIFKAN**!\n\n"
            "⏰ Operasional: 03:00–00:00 WIB\n\n"
            "╚══════════════════════╝"
        )
    elif mode == "off":
        config_data["is_auto_active"] = False
        save_config(config_data)
        await message.edit_text(
            "╔══ 🔴 AUTO POST MATI ══╗\n\n"
            "✅ Posting otomatis berhasil\n**DIMATIKAN**.\n\n"
            "╚══════════════════════╝"
        )
    else:
        await message.edit_text(
            "╔══ ⚠️ PERINTAH SALAH ══╗\n\n"
            "Gunakan `/auto on` atau `/auto off`\n\n"
            "╚══════════════════════╝"
        )


@app.on_message(filters.me & filters.command("status", prefixes="/"))
async def handle_status(client, message):
    """Menampilkan status lengkap bot."""
    active = "🟢 AKTIF" if config_data.get("is_auto_active") else "🔴 NON-AKTIF"
    msgs = config_data.get("main_messages", [])
    fw_msgs = config_data.get("forward_messages", [])
    pool = build_combined_pool()
    total_pool = len(pool)
    total_gb = len(config_data.get("target_groups", []))
    now_wib = datetime.now(WIB).strftime("%H:%M:%S WIB")
    mode_wib = "🌙 Jam Tidur" if is_night_time() else "☀️ Jam Kerja"

    next_info = "—"
    if total_pool > 0:
        idx = config_data.get("current_msg_index", 0) % total_pool
        item = pool[idx]
        if item["type"] == "text":
            next_info = f"📝 Teks #{idx + 1}"
        else:
            lbl = item["content"].get("label", f"FW #{idx + 1 - len(msgs)}")
            next_info = f"📨 Forward: {lbl}"

    await message.edit_text(
        "╔══ ⚙️ STATUS USERBOT ══╗\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        f"🤖 Auto Post    : **{active}**\n"
        f"🕐 Waktu WIB    : {now_wib}\n"
        f"🌤️ Mode         : {mode_wib}\n"
        f"⏰ Operasional  : 03:00 – 00:00 WIB\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        f"📝 Pesan Teks   : `{len(msgs)}` pesan\n"
        f"📨 Pesan Forward: `{len(fw_msgs)}` pesan\n"
        f"🔄 Pool Total   : `{total_pool}` item\n"
        f"🎯 Berikutnya   : {next_info}\n"
        f"👥 Grup Target  : `{total_gb}` grup\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        f"⏱️ Jeda Reply   : **60 detik**\n"
        f"⏱️ Jeda Siklus  : **20–25 menit**\n"
        "━━━━━━━━━━━━━━━━━━━━\n"
        "💬 **Urutan Reply:**\n"
        "  1. `/sharemsg`\n"
        "  2. `/sharemsg2`\n"
        "  3. `/sharemsg3`\n"
        "  4. `/broadcast`\n"
        "  5. `/broadcast2`\n"
        "  6. `/broadcast3`\n"
        "╚══════════════════════╝"
    )


@app.on_message(filters.me & filters.command("help", prefixes="/"))
async def handle_help(client, message):
    """Menampilkan panduan lengkap perintah bot."""
    await message.edit_text(
        "╔══ 📖 PANDUAN PERINTAH USERBOT ══╗\n\n"
        "**📝 PESAN TEKS:**\n"
        "• `/addpesan <teks>` — Tambah pesan teks baru\n"
        "• `/setpesan <teks>` — Reset & set pesan ke-1\n"
        "• `/listpesan` — Lihat semua pesan teks\n"
        "• `/delpesan <no>` — Hapus pesan teks\n\n"
        "**📨 PESAN FORWARD:**\n"
        "• `/addpesanfw [label]` — Simpan pesan forward *(reply ke pesan forward)*\n"
        "• `/listpesanfw` — Lihat semua pesan forward\n"
        "• `/delpesanfw <no>` — Hapus pesan forward\n\n"
        "**👥 GRUP TARGET:**\n"
        "• `/addgb` — Tambah grup saat ini\n"
        "• `/delgb` — Hapus grup saat ini\n"
        "• `/listgb` — Lihat semua grup target\n\n"
        "**⚙️ KONTROL BOT:**\n"
        "• `/auto on` — Aktifkan auto post\n"
        "• `/auto off` — Matikan auto post\n"
        "• `/status` — Cek status lengkap\n"
        "• `/help` — Tampilkan panduan ini\n\n"
        "╚══════════════════════════════╝"
    )


async def main():
    logger.info("Memulai Userbot Telegram...")
    await app.start()
    logger.info("✅ Userbot berhasil terhubung ke Telegram!")
    try:
        logger.info("Memuat cache dialogs...")
        async for _ in app.get_dialogs():
            pass
        logger.info("✅ Cache dialogs berhasil dimuat!")
    except Exception as e:
        logger.warning(f"Gagal memuat cache: {e}")

    asyncio.create_task(auto_post_loop())
    await asyncio.Event().wait()


if __name__ == "__main__":
    try:
        app.run(main())
    except KeyboardInterrupt:
        logger.info("Bot dihentikan oleh pengguna.")
    except Exception as e:
        logger.critical(f"Bot berhenti: {e}")
