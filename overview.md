# 本轮交付概览：补齐架构 §6.7 的第二个 GUI（殖民地面板）

> 项目：VS2 舰船扩展（`D:\mc269\vs2-naval`）· MC 1.20.1 Forge 47.4.1
> 工作流：软件公司 SOP（主理人齐活林 · 架构高见远 · 工程师寇豆码 · QA 严过关）
> 日期：2026-09-10

## 做了什么

架构 SSOT 的 §6.7 明确要求交付**两个 GUI**，此前只落了市场界面。本轮把缺的第二个 ——
**殖民地面板 `ColonyScreen`** —— 补齐到"能编译、有测试、有守卫、能出包"的状态。

| 新增/改动 | 文件 |
|---|---|
| 视图（纯数据 + 纯函数，可 headless 直测） | `colony/.../gui/ColonyView.java` |
| 零槽位容器（线格式唯一写读入口） | `colony/.../gui/ColonyMenu.java` |
| 打开入口（服务端一次性解析快照） | `colony/.../gui/ColonyMenuProvider.java` |
| 界面（纯程序化绘制，无写操作） | `colony/.../gui/ColonyScreen.java` |
| 菜单注册 | `colony/.../registry/NavColonyMenus.java`（+`COLONY_TYPE` = `colony_panel`） |
| 客户端 Screen 注册 | `colony/.../NavalColony.java` |
| 命令 | `colony/.../command/NavalColonyCommand.java`（+`/naval panel [colonyId]`） |
| 语言键 | `lang/zh_cn.json` / `en_us.json`（各 +17 → 146） |
| 测试 | 新建 `gui/ColonyViewTest.java`（18 条）；`qa/ColonySourceContractTest.java` 42 → 44 |

`/naval panel` 与 `/naval info` 是**同一套鉴权、同一份取数、只换载体**（文本 vs 图形），
所以不会出现"文本说一套、面板说另一套"。面板**只读**：注资/扩张/任命总督仍只走命令。

## 关键决策

1. **格式化纯函数上移到 `ColonyView`**：原本写在 `@OnlyIn(CLIENT)` 的 Screen 上，
   headless 单测加载它会碰 GUI 运行时。上移后既可直测，也与市场侧"格式在 `MarketView`、Screen 只画"的既有约定一致。
2. **线格式改成静态写读成对**（`writeAnchor/readAnchor` + `writeSnapshot/readView`）：
   静态才能在 headless 下做"真写进 `FriendlyByteBuf` 再读回来"的往返测试
   （构造 `ColonyMenu` 需要注册表，测试环境是空的）。副产物是 `open()` 里那个"为当写入器而 new 出来的假菜单实例"被消掉了。
3. **只修不绕**：QA 抓出的两个问题都改在产品代码里，而不是让测试绕开。

## 抓出并修复的缺陷

| # | 问题 | 危害 | 处置 |
|---|---|---|---|
| **D12** | `writeAnchor` 无条件写 `writeLong`（恒 9 字节），`readAnchor` 在 null 时只读 1 字节 | 一旦真传 null 锚点，其后整段快照错位 8 字节（`present` 读成 false、`readUtf` 读到伪长度 → `StringIndexOutOfBoundsException`）。生产路径当前不可达，但方法是 public 且参数标 `@Nullable`，类注释还写着"唯一编码/解码、严格成对"——**注释与代码说谎** | 与解码器对齐：非 null 才写 long（与同文件 `writeOptUtf` 同形） |
| **D13** | 面板清单只画 5 类建筑，底部"合计"却累加 6 类（含 `UNKNOWN`） | `UNKNOWN` 是 `Building.Kind.parse` 对无法识别 `type` 的降级产物，**真实可达** ⇒ 有未知建筑时显示「码头 1 · 民居 2 … 合计 4」而可见条目只有 3 | 新增纯函数 `ColonyView.visibleKinds(int unknownCount)`，仅当未知数 > 0 时追加一格 ⇒ **合计恒等于可见条目之和** |

顺带纠正了我自己规格里的一处错误：`Building.Kind` 是 **6** 个值，不是 5 个。

## 验证（我独立复跑，非仅采信 QA）

```
export JAVA_HOME='C:\Program Files\Java\jdk-17'   # 本机默认 JDK 23，不带会报 major version 67
./gradlew --offline clean build   → BUILD SUCCESSFUL in 2m26s (36 tasks executed)

colony   54 xml → 352 tests / 0 fail / 0 err / 1 skip（skip = StructureAssetExportTest，导出器，设计如此）
sailing   4 xml →  68 tests / 0 fail / 0 err / 0 skip      ⇒ 全量 420 / 0 / 0
契约守卫 44 条
产物：colony 380,601 B（228 条目 / 125 class）· core 24,115 B · sailing 102,069 B
      core 与 sailing 字节数与上一轮完全一致 ⇒ 无漂移
jar 内实测：lang 中英各 146 键；gui/ 下 4 个新类均在；5 个 structure/*.nbt 均在
```

**双口径交叉验证**：`grep -rc "@Test"` 逐文件求和 = **352**，与 XML 加总**完全一致**（22 个测试类）。

**变异反证 M5**（证明新测试真有牙）：把 `writeAnchor` 改回无条件写 long →
`ColonyViewTest` 18 tests / **1 failure**（失败在 `wireRoundTripPreservesEveryField`，
形态为 `StringIndexOutOfBoundsException`，栈 `readUtf ← readOptUtf ← readView`）；精确还原后 18 / 0。

## 基线对账（消除 330 vs 332 的疑问）

| 阶段 | tests |
|---|---|
| `p1-removal-audit.md` §6.6 记录的 330 | 330（采于 `template/StructureAsset*Test` 落盘**之前**） |
| + `StructureAssetExportTest` + `StructureAssetParityTest` | 332 |
| + `ColonyViewTest` 16 + 守卫 2 | 350 |
| + `visibleKinds` 回归 2 | **352** |

⇒ §6.6 的 `330/51` 作废（保留为历史留痕），当前口径见该文件**新增的 §6.7**。

## 文档产出

- `docs/delivery-p1.md` —— 双 GUI、jar 380,601 B、352 测试、D12/D13、门禁命令（JAVA_HOME 铁律）、范围裁定 5 条
- `docs/p1-summary.md` —— TL;DR / 验证证据 / 关键裁定 / 下一步 / 环境注意
- `docs/p1-removal-audit.md` —— §6.5 增 D12/D13；**新增 §6.7** 当前终局口径 + 基线对账 + M5
- `docs/qa-report-p1.md` —— 新增 **V-C13**（面板渲染验收项）+ 追加轮次路由判定
- `.probe-logs/p1/t25_panel_gui_gate.txt` —— 出包门禁留痕

## 唯一剩余阻塞条件

**游戏内实机验证**，离线不可替代：**V-C1~V-C13 + V-D1~V-D3**（清单见 `p1-removal-audit.md` §3 与 `qa-report-p1.md` ⑥）。
本轮新增 **V-C13**：`/naval panel` 开出面板不崩、4 行数据与总督三态正确、
含 `UNKNOWN` 建筑时清单多出一格且"合计"等于可见条目之和。

优先级最高的五项：V-C7（五种房型各放一次）· V-C5（`produced=N` 与 purge 不误伤）·
V-C4（咬杀不产僵尸村民）· V-C8（真 jar 起服冒烟）· V-C13（面板渲染）。
另需回归 P0 遗留的 4 项航行验收（`docs/delivery-p0.md`）。
