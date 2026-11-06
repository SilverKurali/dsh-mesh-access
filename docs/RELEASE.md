# 发布清单

每改一次代码，下面四块**必须一起动**，否则就会出现「npm 上是新版、Release 还是旧版、文档写着上上个版本」这种漂移。

## 1. 版本号

- `package.json` 的 `version`
- `CHANGELOG.md` 顶部加一节
- `INSTALL.md` / `INSTALL.en.md` 里出现的 `dsh-phone-tunnel@x.y.z` 命令
- `README.md` / `README.en.md` 里若有版本号（能不带就不带，用 `dsh-phone-tunnel` 拉 latest）

## 2. npm

```bash
npm publish --registry=https://registry.npmjs.org
```

⚠️ `+ dsh-phone-tunnel@x.y.z` 只代表**元数据**提交成功，tarball 可能还要几分钟才可下载。必须探到 200 才算发完：

```bash
curl -sI https://registry.npmjs.org/dsh-phone-tunnel/-/dsh-phone-tunnel-<版本>.tgz | head -1   # 期望 200
```

再看一眼 dist-tags 与 shasum 对不对：

```bash
curl -s https://registry.npmjs.org/dsh-phone-tunnel | python3 -c "import json,sys;d=json.load(sys.stdin);v=d['versions'][d['dist-tags']['latest']];print(d['dist-tags']['latest'], v['dist']['shasum'])"
```

2026-11-07 那次实测：404 持续了约 6 分钟才变 200。这期间 `npm install` 会报 `npm error 404`，看着像发布失败。

## 3. GitHub Release

```bash
npm pack --registry=https://registry.npmjs.org
mv dsh-phone-tunnel-<版本>.tgz dsh-phone-tunnel.tgz        # 附件名不带版本号
git -c tag.gpgSign=false tag -a v<版本> -m "<摘要>"
git -c http.version=HTTP/1.1 push origin refs/tags/v<版本>
gh release create v<版本> dsh-phone-tunnel.tgz --title "v<版本> — <摘要>" --notes-file /tmp/rel-notes.md
```

附件名**必须不带版本号**，因为文档里用的是稳定地址
`https://github.com/SilverKurali/dsh-phone-tunnel/releases/latest/download/dsh-phone-tunnel.tgz`。
发完验一次：

```bash
curl -sIL .../releases/latest/download/dsh-phone-tunnel.tgz | grep -i '^HTTP'
tar -xzOf dsh-phone-tunnel.tgz package/package.json | grep version
```

## 4. 装一次（别信代码，信安装）

```bash
rm -rf ~/.dsh/profiles/reltest && cp -a ~/.dsh/profiles/headless ~/.dsh/profiles/reltest
dsh plugin --profile reltest add dsh-phone-tunnel@<版本> --registry=https://registry.npmjs.org
# 起临时实例 → GET /api/dsh-phone-tunnel/status → POST proxy start → curl 期望 401
rm -rf ~/.dsh/profiles/reltest
```

## 5. 市场条目

`store/dsh-phone-tunnel.yml` 只在**分类、描述、图标、tarball 地址**变化时才需要改；`npm:` 键由 registry 自动采集，**不要手写**。
提交给 `awesome-dsh-plugin` 的 PR 由仓库所有者本人开，AI 只备料。
