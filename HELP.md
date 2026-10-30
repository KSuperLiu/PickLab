# PickLab 帮助：从 GitLab 获取个人访问令牌

PickLab 使用你自己的 GitLab 账号和个人访问令牌（Personal Access Token，简称 PAT）读取项目，并通过 GitLab API 将整条提交遴选到目标分支。每个人都应使用自己的令牌。

## 创建令牌

1. 在浏览器打开并登录你要使用的 GitLab 站点。
2. 点击右上角头像，进入 **Edit profile（编辑个人资料）**。
3. 在左侧选择 **Access → Personal access tokens（访问 → 个人访问令牌）**。不同版本的界面可能直接显示 **Access Tokens**。
4. 如果页面先让你选择令牌类型，在 **Generate token** 中选择 **Legacy token**。
5. 填写便于识别的名称，例如 `PickLab`，并设置到期日期。
6. 在权限范围（Scopes）中勾选 **`api`**，然后点击 **Generate token / Create personal access token**。
7. **立即复制生成的令牌值**。离开或刷新该页面后，GitLab 不会再次显示完整令牌。

PickLab 的直接遴选使用写入 API，单独的 `read_api` 或 `write_repository` 不能代替 `api`。令牌的作用范围仍受你在 GitLab 中的项目和目标分支权限限制。

## 填入 PickLab

1. 在 PickLab 的 **GitLab 项目地址** 填写你的 GitLab 站点地址，或完整项目地址，例如 `https://gitlab.example.com/group/project.git`。
2. 在 **个人访问令牌** 输入框粘贴刚刚复制的**完整令牌值**，不要填令牌名称、用户名或密码。
3. 点击 **使用我的个人令牌登录**。登录后会自动查询当前账号最近推送的项目，也可手动选择其他项目。

PickLab 只在本机服务的运行内存中保存令牌；浏览器只缓存上次成功使用的 GitLab 地址，不缓存令牌。使用 HTTP 地址时，令牌和仓库数据会在网络中以未加密方式传输。

## 常见问题

- **找不到完整令牌值**：GitLab 只在创建时显示一次。请在 GitLab 中重新创建令牌，并将新值填入 PickLab。
- **提示 401**：检查是否粘贴了完整令牌值、令牌是否过期或撤销，以及地址是否属于创建该令牌的 GitLab 站点。
- **提示 403 或不能写入目标分支**：检查令牌是否包含 `api`，以及你的账号是否有目标分支的写入权限。受保护分支可能限制直接写入。

参考：[GitLab 创建个人访问令牌](https://docs.gitlab.com/user/profile/personal_access_tokens/#create-a-personal-access-token)、[GitLab 令牌权限范围](https://docs.gitlab.com/security/tokens/access_token_scopes/)。
