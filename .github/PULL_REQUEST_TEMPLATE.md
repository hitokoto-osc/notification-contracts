## 变更内容

<!-- 改了什么，为什么。受影响的生产方/消费方有哪些。 -->

## 兼容性

- [ ] 已按 README §7 的 SemVer 表判定版本，并同步更新了 `asyncapi.yaml` 的 `info.version`
      与 `package.json` 的 `version`
- [ ] CHANGELOG 已更新
- [ ] 未改动 routing key / queue / exchange / DLX 参数
      （若确有改动：已打 `topology-change` 标签，已升 MAJOR，已在描述里写明四语言迁移步骤）
- [ ] required 字段与枚举取值仍与线上消费侧行为一致
      （若确有收紧：已打 `breaking-change` 标签，已升 MAJOR）
- [ ] 新增/修改字段已同步补进 `examples/`；若是收紧约束，已补 `examples/invalid/` 负样本

## 消费方验证

- [ ] 已在 `notification_worker` 侧更新 submodule 指针并跑通 `Contract regression`
      （或已确认本次变更无需消费侧改动）
