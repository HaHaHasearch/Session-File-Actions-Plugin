# Harness 单交付卡片复制验证包

版本 0.0.4 在原交付卡片菜单提供「复制文件」。需要匹配的补丁桌面版；没有桌面复制桥时该命令禁用。普通文本路径和没有正式交付坐标的本地回显不提供此动作。

操作时 Host 从已认证的 browserPeer 校验会话事件，签发 60 秒有效的一次性随机句柄。句柄限定 Host、会话、操作和附件坐标，最多保留 128 个，卸载时清空。桌面主进程校验主窗口与 mainFrame，通过私有 Host 连接兑换句柄。Host 消费时再次解析正式事件，通过 workspaceFiles 的会话工作区和文件权限边界读取当前源文件，最多 32 MiB；无权限、失效或过大均失败，不改读历史副本。原始路径和字节不作为 renderer 的可信输入。

主进程校验大小与 SHA-256，写入独立副本，再使用 Electron ClipboardItem 的 text/uri-list 发布。系统确认后才反馈成功；系统发布异常显示结果未确认。尚未发布的取消操作清理自身副本，已发布或结果未确认的副本保留到应用退出之后。当前没有自动回收器，磁盘占用会累积；不要手动删除系统剪贴板仍引用的目录。新复制在 Host 授权前由 main 的 begin 受理并立即撤销旧准备的发布资格，即使新授权延迟或失败也不恢复旧操作。客户端同步取消旧授权请求；发布中禁止重入。

从本项目根运行 `pnpm setup`、`pnpm verify`，然后 `pnpm --dir plugins/harness pack --pack-destination <项目内产物目录>`。包内 `lib/index.js` 和 `lib/client.js` 分别是 Host 与 client 入口；`lib/harness-host.patch` 为完整宿主补丁，不依赖开发机源码。

宿主基线为 `8bd073392eef6f54e921a093b95076248eb08cbb`（0.2.2-alpha.3），原卡片坐标补丁候选 `39656190349c05f0a4bbcae26a94674bbc550a93` 保留在本次累计补丁中。新桥、共享源码暂存及重建步骤见项目 `host-patches/harness/README.md`。官方版本号不足以证明有这些接口。

本票只接通单交付卡片复制；批选、上传附件和另存为留在各自任务单。当前反馈使用宿主通知；会话持久进度及显式取消 UI 未实现。最终候选按 [Windows 复制验收步骤](../../tests/windows/README.md) 检查真实粘贴、源文件改写及失败时保留剪贴板。


main 的 begin 回执是受理/替代的唯一边界：返回 false 表示系统仍在发布上一操作，客户端明确反馈 busy，不取消上一结果；返回 true 后才取消旧授权请求。授权请求的 AbortSignal 不用于屏蔽已经交给 main 的 copied/unconfirmed 回执。
