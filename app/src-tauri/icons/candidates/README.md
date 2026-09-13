# 图标源文件（唯一真源）

## 定稿：一束光（spotlight）· 2026-09-13

- `spotlight.svg` — 1024 母版矢量源（824 squircle + 烘焙投影，官方图标规范）。
  已发布到：`../icon.icns`（应用图标）+ `../menubar-Template.svg`（菜单栏剪影版）。
- `panes.svg` / `panes.icns` — 三窗归一（备选，落选待用）。

## 改图标怎么重新出图

```bash
cd app/src-tauri/icons/candidates
qlmanage -t -s 1024 -o . spotlight.svg          # 1024 母版 PNG（透明底）
# iconset 全尺寸 + iconutil 合成 icns（见 git 历史或问 AI）
cp spotlight.icns ../icon.icns
qlmanage -t -s 88 -o ../ menubar-Template.svg   # 菜单栏 88px 位图
```

改完 `cd ../../.. && npm run build` 重新打包即可生效。
若 Dock 显示旧图标：`killall Dock`（图标缓存）。
