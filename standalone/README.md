# manus-codex-bridge (standalone)

把 ChatGPT 套餐变成 OpenAI 兼容接口的**独立版**，三个脚本、零依赖，可以直接拷到任何一台电脑上用。

---

## 一、先理解一件事：为什么每台电脑都要单独授权

这不是可以"装一次到处用"的东西，原因有三个：

1. **回调地址是本机回环**。授权时 OpenAI 会回调 `http://127.0.0.1:1455/auth/callback`，
   这个地址只有**正在跑授权脚本的那台机器**能收到。在 A 机器上点的授权，B 机器收不到回调。

2. **凭证必须各自持有**。refresh token **每次刷新都会轮换**，旧的立即失效。如果两台机器
   共用同一份 `credentials.json`，谁先刷新谁就把对方的凭证作废，两边会互相踢掉。

3. **中继只监听 `127.0.0.1`**。这是有意设计——避免把你的 ChatGPT 额度暴露到局域网或公网。

所以正确做法是：**每台电脑各跑一次授权，各自拿一套 token。** 它们可以复用同一个
`oaiapp_...` client_id（把 `host.json` 一起带过去即可），但 token 必须分开。

---

## 二、三种把它弄到另一台电脑的办法

### 办法 A：从 GitHub 装（推荐）

如果你已经合并了 PR 或想用仓库里的 `mcb` CLI：

```bash
git clone https://github.com/zhiqiang73-cpu/Manus-codex-bridge.git
cd Manus-codex-bridge
node bin/mcb.js login
```

零依赖，不用 `npm install`。

### 办法 B：拷这个独立包（tarball）

在**当前这台机器**打包：

```bash
tar czf manus-codex-bridge-standalone.tar.gz -C outputs manus-codex-bridge-standalone
```

拷过去并安装：

```bash
scp manus-codex-bridge-standalone.tar.gz user@目标主机:~/
ssh user@目标主机 'tar xzf ~/manus-codex-bridge-standalone.tar.gz && cd manus-codex-bridge-standalone && ./install.sh'
```

`install.sh` 会检查 Node 版本、把三个脚本装到 `~/manus-codex-bridge`，并提示下一步。

### 办法 C：只拷三个脚本

如果你已经有目录结构，直接传三个文件就行：

```bash
scp outputs/chatgpt-oauth-login.mjs \
    outputs/codex-relay.mjs \
    outputs/gpt.mjs \
    user@目标主机:~/mcb/
```

然后在目标机器上：

```bash
ssh user@目标主机
cd ~/mcb
node chatgpt-oauth-login.mjs
```

---

## 三、目标机器的要求

| 项目 | 要求 |
|---|---|
| Node.js | **18 或更高**（用到内置 `fetch`） |
| 依赖 | **无**，不需要 `npm install` |
| 系统 | macOS / Linux / Windows 均可 |
| 浏览器 | 一个能打开的浏览器（授权用） |
| 网络 | 能访问 `auth.openai.com` 与 `api.openai.com` |

浏览器打开已做跨平台处理：macOS 用 `open`、Linux 用 `xdg-open`、Windows 用 `start`。
如果都没有（比如无桌面环境的服务器），脚本会**打印授权链接**，你复制到任意浏览器打开即可——
回调仍然会回到那台机器，因为授权链接里的 `redirect_uri` 指向它自己的 `127.0.0.1:1455`。

> 无桌面服务器提示：这种机器上浏览器打不开，但只要你从别处打开链接，
> 回调仍会送到服务器上的监听端口。前提是你能访问到那台机器的 1455 端口——
> 如果不行，就在有浏览器的机器上装。

---

## 四、Windows 特别注意

- `install.sh` 需要 **Git Bash** 或 **WSL** 运行；PowerShell 里跑不了 `.sh`
- 如果只用 PowerShell，跳过 `install.sh`，直接：

  ```powershell
  mkdir $HOME\manus-codex-bridge
  copy chatgpt-oauth-login.mjs,codex-relay.mjs,gpt.mjs $HOME\manus-codex-bridge\
  cd $HOME\manus-codex-bridge
  node chatgpt-oauth-login.mjs
  ```

- 凭证目录在 Windows 上是 `%USERPROFILE%\.config\chatgpt-plan-relay\`
- 首次运行如果 Windows 防火墙弹窗询问，**允许本地回环**即可，不要开放公网

---

## 五、授权完成后怎么用

授权成功后脚本会自动拉起中继并弹出选模型页面（`http://127.0.0.1:8787/`）。

```bash
node gpt.mjs --list                        # 看模型与当前默认
node gpt.mjs -m gpt-6-astra "你的问题"       # 指定模型
node gpt.mjs --stream "你的问题"             # 流式
node gpt.mjs --set-default gpt-5.6-terra    # 改默认模型
```

任何 OpenAI 兼容客户端也可以：`base_url` 指向 `http://127.0.0.1:8787/v1`，
`api_key` 填任意非空字符串。

---

## 六、常见问题

**Q：能不能把 `credentials.json` 拷过去省一次授权？**
技术上可以（它是 bearer token），但**不要这么做**——见第一节第 2 点，两台机器会互相作废对方的
refresh token。而且 token 会随刷新不断变化。

**Q：能不能让别的机器通过局域网访问我的中继？**
可以，但要先设置 `RELAY_TOKEN`，否则等于把你的 ChatGPT 额度公开在局域网上：

```bash
RELAY_TOKEN=<强随机串> node codex-relay.mjs --host=0.0.0.0
```

**Q：一台机器能用几个账号？**
一个 `~/.config/chatgpt-plan-relay/` 对应一套凭证。要换账号就重新跑一次授权
（旧凭证会先备份为 `credentials.backup.json`）。

**Q：`token 已过期` 怎么办？**
中继会在到期前 2 分钟自动刷新。如果 refresh token 本身失效（30 天不用、或已被轮换掉），
重新跑 `node chatgpt-oauth-login.mjs` 即可。

**Q：怎么彻底卸载？**
删掉安装目录，再删掉凭证目录：

```bash
rm -rf ~/manus-codex-bridge
rm -rf ~/.config/chatgpt-plan-relay
```

---

## 七、文件说明

| 文件 | 作用 |
|---|---|
| `chatgpt-oauth-login.mjs` | 官方 OAuth 授权 + 令牌校验 + 自动拉起中继与选模型页 |
| `codex-relay.mjs` | 中继本体：Chat Completions ↔ 官方 Responses，含选模型页 |
| `gpt.mjs` | 命令行入口，指定模型调用 |
| `install.sh` | 一键安装脚本 |
