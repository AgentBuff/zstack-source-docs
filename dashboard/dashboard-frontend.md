# Dashboard 前端

Dashboard 前端基于 AngularJS 1.x + TypeScript + Kendo UI + Bootstrap，采用 `tsc --out` 编译为单个 `app.js`。

## 技术栈与构建

`zstack-dashboard/compilets.sh:1-37`

```bash
#!/bin/sh
cd ts
tsc --out app.js \
    api.ts utils.ts app.ts sideBar.ts nav.ts \
    zone.ts cluster.ts primaryStorage.ts l2Network.ts l3Network.ts \
    backupStorage.ts host.ts image.ts instanceOffering.ts diskOffering.ts \
    apiDetails.ts vm.ts volume.ts securityGroup.ts \
    vip.ts eip.ts portForwarding.ts virtualRouter.ts \
    virtualRouterOffering.ts dashboard.ts globalConfig.ts directives.ts
```

所有 TypeScript 文件编译为单个 `app.js`，无模块打包器。文件顺序决定依赖关系：`app.ts` 依赖 `api.ts` 和 `utils.ts`，所以 `api.ts` 和 `utils.ts` 必须在前。

## 模块架构

```
MRoot (根模块)
├── 登录/登出/改密码/会话管理
├── Angular 路由 (/login, /dashboard)
└── i18n (angular-translate, en_US/zh_CN/zh_TW)

ApiHeader (API 消息定义)
├── APIMessage 基类
├── QueryObject 查询对象
└── 300+ API 消息/回复 TypeScript 类

Utils (核心服务)
├── Api — HTTP 调用封装 (syncCall/asyncCall/poll)
├── Tag — 标签 CRUD
├── Chain — 前端 FlowChain
├── OGrid — Kendo Grid 封装
└── WizardButton/WizardPage/WizardMediator — 向导框架

MVmInstance (VM 管理)
├── VmInstanceManager — 数据操作
├── Controller — 列表页
├── DetailsController — 详情页
└── CreateVmInstance/MigrateVm — 指令（对话框）

MDashboard (仪表盘)
├── 容量表格 (CPU/内存/存储/IP)
└── 资源数量表格 (VM/云盘/安全组/EIP 等)
```

## 根模块 MRoot

`zstack-dashboard/ts/app.ts:5-172`

### 会话管理

```typescript
module MRoot {
    export class main {
        static $inject = ['$scope', '$rootScope', 'Api', 'ApiDetails',
                          '$location', '$cookies', '$translate'];

        constructor(private $scope, private $rootScope, private api,
                     private apiDetails, private $location, private $cookies,
                     private $translate) {
            // 启动时检查 cookie 中的 session
            if (Utils.notNullnotUndefined($cookies.sessionUuid)) {
                var msg = new ApiHeader.APIValidateSessionMsg();
                msg.sessionUuid = $cookies.sessionUuid;
                this.api.syncApi(msg, (ret) => {
                    if (ret.success && ret.validSession) {
                        $rootScope.sessionUuid = $cookies.sessionUuid;
                        $rootScope.loginFlag = true;
                        $location.path("/dashboard");
                    }
                });
            }
        }
    }
}
```

### 登录流程

```typescript
$scope.login = () => {
    var msg = new ApiHeader.APILogInByAccountMsg();
    msg.accountName = $scope.username;
    msg.password = CryptoJS.SHA512($scope.password).toString();  // SHA512 哈希
    this.api.syncApi(msg, (ret) => {
        if (ret.success) {
            $rootScope.loginFlag = true;
            $rootScope.sessionUuid = ret.inventory.uuid;
            $cookies.sessionUuid = ret.inventory.uuid;
            $cookies.accountName = $scope.username;
            $location.path("/dashboard");
        } else {
            $scope.logInError = true;
        }
    });
};
```

### 路由配置

`zstack-dashboard/ts/app.ts:192-217`

```typescript
angular.module("root", ['app.service', 'kendo.directives', 'ngRoute',
                         'ngTagsInput', 'ngCookies', 'pascalprecht.translate'])
    .config(['$routeProvider', function(route) {
        route.when('/login', {
            templateUrl: '/static/templates/login/login.html',
            controller: 'MRoot.main'
        }).otherwise({
            redirectTo: '/dashboard'  // 默认跳转仪表盘
        });
    }])
    .config(function($translateProvider) {
        $translateProvider.useStaticFilesLoader({
            prefix: '/static/resources/locale-',
            suffix: '.json'
        });
        $translateProvider.preferredLanguage('en_US');
    });
```

## API 消息定义 ApiHeader

`zstack-dashboard/ts/api.ts:1-9493`

每个 API 消息对应一个 TypeScript 类，实现 `APIMessage` 接口：

```typescript
module ApiHeader {
    export interface APIMessage {
        session: SessionInventory;
        toApiMap(): any;
    }

    export class APICreateVmInstanceMsg implements APIMessage {
        session: SessionInventory;
        name: string;
        instanceOfferingUuid: string;
        imageUuid: string;
        l3NetworkUuids: string[];
        defaultL3NetworkUuid: string;
        zoneUuid: string;
        clusterUuid: string;
        hostUuid: string;
        description: string;

        toApiMap(): any {
            // 将消息转为 JSON 格式：{ "消息全限定名": { 字段... } }
            var map: any = {};
            map['org.zstack.header.vm.APICreateVmInstanceMsg'] = this;
            return map;
        }
    }
}
```

`toApiMap()` 的输出格式与后端 CloudBus 消息协议一致：单 key 为消息全限定名。

## 核心服务 Utils.Api

`zstack-dashboard/ts/utils.ts:47-393`

### 同步调用

```typescript
private syncCall(msg: APIMessage, callback: (result: any) => void,
                 error?: (reason: string, statusCode: number) => void): void {
    msg.session = this.session;  // 注入 session
    this.$http.post(Api.SYNC_CALL_PATH, msg.toApiMap())
        .success((rsp: any) => {
            var ret: APIReply = Utils.firstItem(rsp);
            // ID.1001 = 认证失败，跳转登录页
            if (!ret.success && ret.error && ret.error.code == 'ID.1001') {
                this.$location.path('/login');
                return;
            }
            callback(Utils.firstItem(rsp));
        });
}
```

### 异步调用与轮询

```typescript
private asyncCall(msg: APIMessage, callback: (result: any) => void,
                   error?: Function): void {
    msg.session = this.session;
    this.$http.post(Api.ASYNC_CALL_PATH, msg.toApiMap())
        .success((receipt: Receipt) => {
            this.poll(receipt, callback, error);  // 开始轮询
        });
}

private poll(receipt: Receipt, callback: Function, error: Function): void {
    if (receipt.status == Api.STATUS_DONE) {
        // 完成，触发回调
        var rsp = Utils.firstItem(receipt.rsp);
        if (rsp.success) {
            callback(rsp);
        } else {
            error(rsp);
        }
        return;
    }

    // 未完成，1 秒后重试
    this.$http.post(Api.QUERY_PATH, receipt.id)
        .success((re: Receipt) => {
            if (re.status == Api.STATUS_DONE) {
                // 处理完成...
            } else {
                setTimeout(() => {
                    Utils.safeApply(this.$rootScope, () => {
                        this.poll(re, callback, error);  // 递归轮询
                    });
                }, 1000);  // 1 秒间隔
            }
        });
}
```

### 公共 API 方法

```typescript
public syncApi(data: APIMessage, callback: Function, error?: Function): void {
    // 从 $rootScope 获取最新 session
    if (Utils.notNullnotUndefined(this.$rootScope.sessionUuid)) {
        this.session = new ApiHeader.SessionInventory();
        this.session.uuid = this.$rootScope.sessionUuid;
    }
    this.syncCall(data, callback, error);
}

public asyncApi(data: APIMessage, callback: Function, error?: Function): void {
    if (Utils.notNullnotUndefined(this.$rootScope.sessionUuid)) {
        this.session = new ApiHeader.SessionInventory();
        this.session.uuid = this.$rootScope.sessionUuid;
    }
    this.asyncCall(data, callback, error);
}
```

## 前端 FlowChain：Chain

`zstack-dashboard/ts/utils.ts:395-460`

前端也实现了类似后端 FlowChain 的链式调用：

```typescript
export class Chain {
    private flows: Function[] = [];
    private errorHandler: Function;
    private doneHandler: Function;

    then(func: Function): Chain {
        this.flows.push(func);
        return this;  // 支持链式调用
    }

    done(handler: Function): Chain {
        this.doneHandler = handler;
        return this;
    }

    error(handler: Function): Chain {
        this.errorHandler = handler;
        return this;
    }

    start(): void {
        this.next();
    }

    private next(): void {
        if (this.flows.length == 0) {
            if (this.doneHandler) this.doneHandler();
            return;
        }
        var flow = this.flows.shift();
        flow(this.next.bind(this));  // 传入 next，flow 完成后调用
    }
}
```

使用示例：

```typescript
new Utils.Chain()
    .then((next) => { /* 步骤1 */ next(); })
    .then((next) => { /* 步骤2 */ next(); })
    .done(() => { /* 全部完成 */ })
    .start();
```

## Kendo Grid 封装：OGrid

`zstack-dashboard/ts/utils.ts`（OGrid 类）

OGrid 封装了 Kendo Grid 的常用配置：

```typescript
export class OGrid {
    dataSource: kendo.data.DataSource;
    columns: any[];
    selectable: string = "row";
    pageable: any = { pageSizes: [20, 50, 100] };
    sortable: boolean = true;

    // 刷新数据
    refresh(): void {
        this.dataSource.read();
    }

    // 获取选中行
    selectedItem(): any {
        return this.dataSource.view()
            .filter(item => item.isSelected());
    }
}
```

## VM 管理模块 MVmInstance

`zstack-dashboard/ts/vm.ts:1-1573`

### VmInstanceManager

```typescript
module MVmInstance {
    export class VmInstanceManager {
        static $inject = ['Api'];

        constructor(private api: Utils.Api) {}

        createVm(msg: ApiHeader.APICreateVmInstanceMsg,
                 done: (ret: ApiHeader.APICreateVmInstanceEvent) => void) {
            this.api.asyncApi(msg, done);  // 异步创建
        }

        startVm(uuid: string, done: Function) {
            var msg = new ApiHeader.APIStartVmInstanceMsg();
            msg.uuid = uuid;
            this.api.asyncApi(msg, done);
        }

        stopVm(uuid: string, done: Function) {
            var msg = new ApiHeader.APIStopVmInstanceMsg();
            msg.uuid = uuid;
            this.api.asyncApi(msg, done);
        }

        rebootVm(uuid: string, done: Function) {
            var msg = new ApiHeader.APIRebootVmInstanceMsg();
            msg.uuid = uuid;
            this.api.asyncApi(msg, done);
        }

        migrateVm(uuid: string, hostUuid: string, done: Function) {
            var msg = new ApiHeader.APIMigrateVmMsg();
            msg.vmInstanceUuid = uuid;
            msg.hostUuid = hostUuid;
            this.api.asyncApi(msg, done);
        }
    }
}
```

### 列表页 Controller

```typescript
export class Controller {
    static $inject = ['$scope', 'VmInstanceManager', 'Api'];

    constructor(private $scope, private vmMgr: VmInstanceManager,
                 private api: Utils.Api) {
        // 配置 Kendo Grid
        $scope.vmGridOptions = {
            dataSource: {
                transport: {
                    read: (options) => {
                        var msg = new ApiHeader.APIQueryVmInstanceMsg();
                        msg.conditions = $scope.conditions;
                        this.api.syncApi(msg, (ret) => {
                            options.success(ret.inventories);
                        });
                    }
                },
                pageSize: 20
            },
            columns: [
                { field: 'name', title: 'Name' },
                { field: 'state', title: 'State' },
                { field: 'hypervisorType', title: 'Hypervisor' },
                // ...
            ]
        };
    }
}
```

### 创建 VM 向导

CreateVmInstance 是一个 Angular 指令，实现向导式创建流程：

```
步骤1: 选择规格 (InstanceOffering)
步骤2: 选择镜像 (Image)
步骤3: 选择网络 (L3Network)
步骤4: 选择可用区 (Zone/Cluster/Host)
```

## 仪表盘模块 MDashboard

`zstack-dashboard/ts/dashboard.ts:1-432`

仪表盘展示两个 Kendo Grid：

```typescript
module MDashboard {
    export class Controller {
        static $inject = ['$scope', 'Api'];

        constructor(private $scope, private api: Utils.Api) {
            // 容量表格
            $scope.capacityOptions = {
                columns: [
                    { field: 'name', title: 'Resource' },
                    { field: 'total', title: 'Total' },
                    { field: 'available', title: 'Available' }
                ]
            };

            // 资源数量表格
            $scope.resourceCountOptions = {
                columns: [
                    { field: 'name', title: 'Resource Type' },
                    { field: 'count', title: 'Count' }
                ]
            };
        }
    }
}
```

## 导航与侧边栏

### 导航栏 nav.ts

`zstack-dashboard/ts/nav.ts:1-51`

追踪 pending 请求数和 ZStack 版本号，显示在顶部导航栏。

### 侧边栏 sideBar.ts

`zstack-dashboard/ts/sideBar.ts:1-110`

Kendo TreeView 实现的侧边栏导航：

```
├── Compute
│   ├── Instance
│   ├── Host
│   ├── Cluster
│   └── Zone
├── Storage
│   ├── Primary Storage
│   └── Backup Storage
├── Network
│   ├── L2 Network
│   ├── L3 Network
│   └── Network Service
│       ├── Security Group
│       ├── EIP
│       ├── Port Forwarding
│       └── VIP
└── Configuration
```

## 每个资源模块的统一模式

所有资源模块（zone.ts, cluster.ts, host.ts, image.ts 等）遵循相同的模式：

```
M{ResourceName} 模块
├── {ResourceName}Manager  — 数据操作（CRUD + 特殊操作）
├── Controller             — 列表页（Kendo Grid + 搜索/过滤/排序）
├── DetailsController      — 详情页（子资源表格 + 标签 + 操作按钮）
└── {Action}Directive      — 对话框指令（创建/编辑/迁移等）
```

每个 Manager 通过 `Utils.Api` 的 `syncApi`/`asyncApi` 与后端通信，Controller 通过 Manager 操作数据，Directive 封装对话框 UI。

## 前后端交互总结

```
TypeScript (前端)              Flask (后端)                管理节点 (Java)
─────────────────              ────────────                ──────────────
APIMessage.toApiMap()
    │
    ├── POST /api/sync ──────> CloudBus.call() ────────> API Service
    │                         (同步等待回复)              │
    │   <── JSON reply ────── <──────────────────────── <── Reply
    │
    ├── POST /api/async ─────> CloudBus.send() ────────> API Service
    │   <── Receipt JSON      (异步，不等待)              │
    │                                                     │ (处理中...)
    ├── POST /api/query ────> Server.api_query()          │
    │   <── {status:1}       (PROCESSING)                 │
    │                                                     │
    ├── POST /api/query ────> Server.api_query()          │
    │   <── {status:2, rsp}  (DONE)          <── Reply ─ <── Reply
    │
    └── callback(rsp)
```
