# Git 与公开仓库

公开仓库：`https://github.com/SvenKunkka/qmk-vibe-bridge`

本地开发与推送：

```sh
cd ~/qmk-vibe-bridge
git add .
git status                     # 确认 .gitignore 生效（release/dist/node_modules 不应出现）
git commit -m "Describe the change"
git push -u origin main                    # 仅在你确认后
```

## 约束（agent 不会自动执行）

- **不在缺少用户明确授权时 push、发布 Release、配置凭证或 secrets**。
- 当前许可证为源码可见、保留全部权利；公开可见不等于开源授权。
- `.github/workflows/` 的三个 workflow 在 push 到 `main` / 打 `v*` tag / workflow_dispatch 时触发；
  PR 只上传临时 artifacts，不创建 Release。

## 提交前检查

```sh
npm run build && npm test && node scripts/firmware-static-check.mjs   # 全绿
node scripts/doctor.mjs                                               # 环境自检
git status --short                                                    # 无 release/dist/调试残留
```
