# 如何开发新插件

本文以"添加一个自定义网络服务提供者"为例，演示开发 ZStack 插件的完整流程。参照 ZStack 中 VirtualRouter DNS 后端的实际实现模式。

## 插件开发概述

ZStack 插件通过 Spring XML 声明 Bean，实现 ExtensionPoint 接口，由 PluginRegistry 自动收集。插件可以：

- 实现 NetworkServiceProvider 后端
- 添加新的 Hypervisor 类型
- 添加新的存储类型
- 添加新的资源扩展点

## 案例：自定义 DNS 服务提供者

需求：添加一个自定义 DNS 服务提供者，在 VM 启动时自动配置 DNS 服务器。

## 第 1 步：创建 Maven 模块

`zstack/plugin/customDns/pom.xml`

```xml
<project>
    <parent>
        <groupId>org.zstack</groupId>
        <artifactId>zstack-plugin</artifactId>
        <version>1.0</version>
    </parent>
    <artifactId>customDns</artifactId>
    <dependencies>
        <dependency>
            <groupId>org.zstack</groupId>
            <artifactId>header</artifactId>
            <version>${project.version}</version>
        </dependency>
        <dependency>
            <groupId>org.zstack</groupId>
            <artifactId>network</artifactId>
            <version>${project.version}</version>
        </dependency>
    </dependencies>
</project>
```

在父 POM 中添加子模块：

`zstack/plugin/pom.xml`

```xml
<modules>
    <!-- 已有模块 -->
    <module>customDns</module>
</modules>
```

## 第 2 步：定义常量

`zstack/plugin/customDns/src/main/java/org/zstack/network/service/dns/CustomDnsConstant.java`

```java
package org.zstack.network.service.dns;

public interface CustomDnsConstant {
    String CUSTOM_DNS_PROVIDER_TYPE = "CustomDns";
    String CUSTOM_DNS_NETWORK_SERVICE_TYPE = "DNS";

    String CUSTOM_DNS_CONFIGURE_PATH = "/customdns/configure";
}
```

## 第 3 步：实现 NetworkServiceProvider 后端

ZStack 中 VirtualRouter 的网络服务后端继承 `AbstractVirtualRouterBackend`（如 `VirtualRouterDnsBackend`、`VirtualRouterEipBackend` 等）。对于自定义 DNS 提供者，我们参照此模式：

`zstack/plugin/customDns/src/main/java/org/zstack/network/service/dns/CustomDnsProvider.java`

```java
package org.zstack.network.service.dns;

public class CustomDnsProvider extends AbstractVirtualRouterBackend
        implements NetworkServiceDnsBackend {

    @Autowired
    private CloudBus bus;

    @Autowired
    protected DatabaseFacade dbf;

    @Override
    public NetworkServiceProviderType getProviderType() {
        return new NetworkServiceProviderType(
            CustomDnsConstant.CUSTOM_DNS_PROVIDER_TYPE);
    }

    @Override
    public void addDns(L3NetworkInventory l3, List<String> dns,
                       final Completion completion) {
        VirtualRouterVmInventory vr = vrMgr.getVirtualRouterVm(l3);
        if (vr == null || !VmInstanceState.Running.toString().equals(vr.getState())) {
            completion.success();
            return;
        }

        SetDnsCmd cmd = new SetDnsCmd();
        cmd.setDns(buildDnsInfo(vr.getUuid(), null));

        VirtualRouterAsyncHttpCallMsg msg = new VirtualRouterAsyncHttpCallMsg();
        msg.setVmInstanceUuid(vr.getUuid());
        msg.setPath(CustomDnsConstant.CUSTOM_DNS_CONFIGURE_PATH);
        msg.setCommand(cmd);
        msg.setCheckStatus(true);
        bus.makeTargetServiceIdByResourceUuid(msg, VmInstanceConstant.SERVICE_ID, vr.getUuid());
        bus.send(msg, new CloudBusCallBack(completion) {
            @Override
            public void run(MessageReply reply) {
                if (!reply.isSuccess()) {
                    completion.fail(reply.getError());
                    return;
                }

                VirtualRouterAsyncHttpCallReply r = reply.castReply();
                SetDnsRsp rsp = r.toResponse(SetDnsRsp.class);
                if (!rsp.isSuccess()) {
                    completion.fail(operr("operation error, because:%s", rsp.getError()));
                    return;
                }

                completion.success();
            }
        });
    }

    @Override
    public void removeDns(L3NetworkInventory l3, List<String> dns,
                          final Completion completion) {
        completion.success();
    }

    @Override
    public void applyDnsService(List<DnsStruct> dnsStructList,
                                VmInstanceSpec spec, Completion completion) {
        completion.success();
    }

    @Override
    public void releaseDnsService(List<DnsStruct> dnsStructList,
                                  VmInstanceSpec spec, NoErrorCompletion completion) {
        completion.done();
    }
}
```

> **注**：实际源码中，VirtualRouter 的网络服务后端继承 `AbstractVirtualRouterBackend`（而非虚构的 `AbstractNetworkServiceProviderBackend`）。该基类提供 `@Autowired PluginRegistry` 和 `@Autowired VirtualRouterManager vrMgr`，以及 `acquireVirtualRouterVm()` 辅助方法。与 kvmagent 的通信通过 `VirtualRouterAsyncHttpCallMsg` + CloudBus 完成，而非直接调用 `restf.asyncJsonCall()`。

## 第 4 步：实现 Provider Factory

`zstack/plugin/customDns/src/main/java/org/zstack/network/service/dns/CustomDnsProviderFactory.java`

```java
package org.zstack.network.service.dns;

public class CustomDnsProviderFactory
        implements NetworkServiceProviderFactory,
                   ResourceLifecycleExtensionPoint,
                   Component {

    @Autowired
    private CloudBus bus;

    @Autowired
    private PluginRegistry pluginRgty;

    private List<String> providerTypes;

    @Override
    public NetworkServiceProviderType getProviderType() {
        return new NetworkServiceProviderType(
            CustomDnsConstant.CUSTOM_DNS_PROVIDER_TYPE);
    }

    @Override
    public NetworkServiceProviderBackend createNetworkServiceProviderBackend(
            NetworkServiceProviderVO vo) {
        CustomDnsProvider backend = new CustomDnsProvider();
        return backend;
    }

    @Override
    public List<String> getSupportedNetworkServiceTypes() {
        if (providerTypes == null) {
            providerTypes = Collections.singletonList(
                CustomDnsConstant.CUSTOM_DNS_NETWORK_SERVICE_TYPE);
        }
        return providerTypes;
    }

    @Override
    public boolean start() {
        return true;
    }

    @Override
    public boolean stop() {
        return true;
    }
}
```

## 第 5 步：实现 VM 启动扩展点

在 VM 启动后自动配置 DNS：

`zstack/plugin/customDns/src/main/java/org/zstack/network/service/dns/CustomDnsExtension.java`

```java
package org.zstack.network.service.dns;

public class CustomDnsExtension
        implements VmInstanceExtensionPoint,
                   Component {

    @Autowired
    private CloudBus bus;

    @Autowired
    private DatabaseFacade dbf;

    @Override
    public void afterStartVmInstance(VmInstanceInventory inv) {
        for (VmNicInventory nic : inv.getVmNics()) {
            L3NetworkVO l3 = dbf.findByUuid(nic.getL3NetworkUuid(),
                                             L3NetworkVO.class);

            NetworkServiceL3NetworkRefVO ref = SQL.New(
                NetworkServiceL3NetworkRefVO.class)
                .eq(NetworkServiceL3NetworkRefVO_.l3NetworkUuid, l3.getUuid())
                .eq(NetworkServiceL3NetworkRefVO_.networkServiceType,
                    CustomDnsConstant.CUSTOM_DNS_NETWORK_SERVICE_TYPE)
                .find();

            if (ref != null) {
                configureDnsOnVirtualRouter(inv, nic, l3);
            }
        }
    }

    private void configureDnsOnVirtualRouter(VmInstanceInventory inv,
                                             VmNicInventory nic,
                                             L3NetworkVO l3) {
        VirtualRouterVmInventory vr = vrMgr.getVirtualRouterVm(
            L3NetworkInventory.valueOf(l3));
        if (vr == null) {
            return;
        }

        SetDnsCmd cmd = new SetDnsCmd();
        cmd.setDns(buildDnsInfo(vr.getUuid(), null));

        VirtualRouterAsyncHttpCallMsg msg = new VirtualRouterAsyncHttpCallMsg();
        msg.setVmInstanceUuid(vr.getUuid());
        msg.setPath(CustomDnsConstant.CUSTOM_DNS_CONFIGURE_PATH);
        msg.setCommand(cmd);
        msg.setCheckStatus(true);
        bus.makeTargetServiceIdByResourceUuid(msg, VmInstanceConstant.SERVICE_ID, vr.getUuid());
        bus.send(msg, new CloudBusCallBack() {
            @Override
            public void run(MessageReply reply) {
                if (!reply.isSuccess()) {
                    logger.warn(String.format(
                        "failed to configure DNS for VM[uuid:%s], %s",
                        inv.getUuid(), reply.getError()));
                } else {
                    logger.debug(String.format(
                        "configured DNS for VM[uuid:%s]", inv.getUuid()));
                }
            }
        });
    }

    // 其他 VmInstanceExtensionPoint 方法（空实现）
    @Override public void beforeStartVmInstance(VmInstanceInventory inv) {}
    @Override public void beforeStopVmInstance(VmInstanceInventory inv) {}
    @Override public void afterStopVmInstance(VmInstanceInventory inv) {}
    @Override public void beforeRebootVmInstance(VmInstanceInventory inv) {}
    @Override public void afterRebootVmInstance(VmInstanceInventory inv) {}
    @Override public void beforeMigrateVmInstance(VmInstanceInventory inv) {}
    @Override public void afterMigrateVmInstance(VmInstanceInventory inv) {}
    @Override public void beforeDestroyVmInstance(VmInstanceInventory inv) {}
    @Override public void afterDestroyVmInstance(VmInstanceInventory inv) {}

    @Override public boolean start() { return true; }
    @Override public boolean stop() { return true; }
}
```

> **注**：与 VirtualRouter 通信的标准模式是 `VirtualRouterAsyncHttpCallMsg` + CloudBus，而非直接调用 `restf.asyncJsonCall()`。`VirtualRouterAsyncHttpCallMsg` 内部会通过 CloudBus 路由到 VR VM 所在的 ManagementNode，再由该节点的 `VirtualRouterManager` 通过 HTTP 发送到 VR Agent。

## 第 6 步：在 kvmagent 中实现

`zstack-utility/kvmagent/kvmagent/plugins/customdns_plugin.py`

```python
from kvmagent import kvmagent
from zstacklib.utils import http
from zstacklib.utils import log
from zstacklib.utils import jsonobject
from zstacklib.utils import linux
from zstacklib.utils import plugin

logger = log.get_logger(__name__)

class CustomDnsConfigureCmd(kvmagent.AgentCommand):
    def __init__(self):
        super(CustomDnsConfigureCmd, self).__init__()
        self.dns = None

class CustomDnsConfigureRsp(kvmagent.AgentResponse):
    def __init__(self):
        super(CustomDnsConfigureRsp, self).__init__()

class CustomDnsPlugin(kvmagent.KvmAgent):
    DNS_CONFIGURE_PATH = '/customdns/configure'

    @kvmagent.replyerror
    def configure(self, req):
        cmd = jsonobject.loads(req[http.REQUEST_BODY])
        rsp = CustomDnsConfigureRsp()

        try:
            dns_servers = cmd.dns
            for dns_info in dns_servers:
                logger.debug('configure DNS %s for NIC %s' %
                    (dns_info.dnsAddress, dns_info.nicMac))
        except Exception as e:
            logger.warn(linux.get_exception_stacktrace())
            rsp.error = str(e)
            rsp.success = False

        return jsonobject.dumps(rsp)

    def start(self):
        http_server = kvmagent.get_http_server()
        http_server.register_async_uri(self.DNS_CONFIGURE_PATH, self.configure)
```

> **注**：实际 kvmagent 的关键模式：
> - 插件类继承 `kvmagent.KvmAgent`（来自 `from kvmagent import kvmagent`）
> - 路由在 `start()` 方法中通过 `http_server.register_async_uri(path, handler)` 注册
> - 处理方法使用 `@kvmagent.replyerror` 装饰器自动捕获异常
> - 请求体通过 `req[http.REQUEST_BODY]` 获取，而非 `req.body`
> - 不存在 `@plugin.handle_request` 装饰器，也不存在 `import plugin` 的用法（正确导入为 `from zstacklib.utils import plugin`）

## 第 7 步：插件自动发现

kvmagent 使用 `PluginRegistry` 自动发现 `plugins/` 目录下的插件，无需手动注册：

`zstack-utility/kvmagent/kvmagent/kvmagent.py`

```python
class KvmRESTService(object):
    PLUGIN_PATH = 'plugin_path'

    def __init__(self, config={}):
        self.config = config
        plugin_path = self._get_config(self.PLUGIN_PATH)
        if not plugin_path:
            plugin_path = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'plugins')
        self.plugin_path = plugin_path
        self.plugin_rgty = plugin.PluginRegistry(self.plugin_path)

    def start(self, in_thread=True):
        config = {}
        self.plugin_rgty.configure_plugins(config)
        self.plugin_rgty.start_plugins()
        if in_thread:
            self.http_server.start_in_thread()
        else:
            self.http_server.start()
```

只需将 `customdns_plugin.py` 放入 `kvmagent/plugins/` 目录，`PluginRegistry` 会自动发现并加载它。**不需要**手动维护 `PLUGINS` 列表。

> **注**：实际源码中不存在 `PLUGINS` 列表。`PluginRegistry` 扫描 `plugins/` 目录下所有 `.py` 文件，自动加载继承自 `plugin.Plugin` 的类。

## 第 8 步：Spring XML 配置

`zstack/plugin/customDns/src/main/resources/customDns.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<beans xmlns="http://www.springframework.org/schema/beans">
    <bean id="CustomDnsProviderFactory"
          class="org.zstack.network.service.dns.CustomDnsProviderFactory"/>

    <bean id="CustomDnsExtension"
          class="org.zstack.network.service.dns.CustomDnsExtension"/>
</beans>
```

## 第 9 步：注册 Spring 配置

在 `conf/springConfigXml/` 下添加引用：

`zstack/conf/springConfigXml/customDns.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<beans>
    <import resource="classpath:customDns.xml"/>
</beans>
```

## 第 10 步：编写测试

`zstack/test/src/test/groovy/org/zstack/test/customdns/TestCustomDns.groovy`

```groovy
class TestCustomDns extends SubCase {
    EnvSpec env

    @Override
    void setSpringSpec() {
        _springSpec = makeSpring {
            includeCoreServices()
            kvm()
            flatNetwork()
            include("customDns.xml")
        }
    }

    @Override
    void environment() {
        env = makeEnv {
            zone {
                name = "z1"
                cluster {
                    name = "c1"
                    hypervisorType = "KVM"
                    kvmHost { name = "h1"; managementIp = "192.168.1.10" }
                }
                l2NoVlanNetwork {
                    name = "l2"
                    l3Network {
                        name = "l3"
                        category = "Private"
                        ipRange { name = "ipr"; startIp = "10.0.0.2"; endIp = "10.0.0.254"; gateway = "10.0.0.1"; netmask = "255.255.255.0" }
                        service {
                            provider = "CustomDns"
                            networkServiceTypes = ["DNS"]
                        }
                    }
                }
                nfsPrimaryStorage { name = "ps"; url = "nfs://127.0.0.1/nfs" }
                sftpBackupStorage {
                    name = "bs"; url = "/bs"; username = "admin"; password = "password"
                    image { name = "img"; url = "http://127.0.0.1/img.qcow2"; format = "qcow2"; mediaType = "RootVolumeTemplate"; guestOsType = "Linux" }
                }
            }
            instanceOffering { name = "off"; cpuNum = 1; memorySize = 1073741824 }
        }
    }

    @Override
    void test() {
        env.create {}

        env.simulator("customdns/configure") { HttpEntity<String> e ->
            return httpSuccess()
        }

        def vm = createVmInstance {
            name = "test-vm"
            instanceOfferingUuid = env.specByName("off").inventory.uuid
            imageUuid = env.specByName("img").inventory.uuid
            l3NetworkUuids = [env.specByName("l3").inventory.uuid] as List
            defaultL3NetworkUuid = env.specByName("l3").inventory.uuid
            zoneUuid = env.specByName("z1").inventory.uuid
        }

        assert env.getHttpHandlerCount("customdns/configure") == 1
    }

    @Override
    void clean() {
        env.delete()
    }
}
```

## 插件开发检查清单

| 步骤 | 文件位置 | 说明 |
|------|---------|------|
| Maven 模块 | `plugin/customDns/pom.xml` | 依赖 header + network |
| 常量 | `.../CustomDnsConstant.java` | Provider 类型、服务类型、Agent 路径 |
| Provider 后端 | `.../CustomDnsProvider.java` | 继承 AbstractVirtualRouterBackend，实现 NetworkServiceDnsBackend |
| Provider Factory | `.../CustomDnsProviderFactory.java` | 创建后端实例，声明支持的服务类型 |
| 扩展点实现 | `.../CustomDnsExtension.java` | 实现 VmInstanceExtensionPoint |
| Agent 实现 | `kvmagent/plugins/customdns_plugin.py` | 继承 kvmagent.KvmAgent，自动发现 |
| Spring XML | `resources/customDns.xml` | 声明 Bean |
| Spring 引用 | `conf/springConfigXml/customDns.xml` | 导入 Bean 配置 |
| 测试 | `test/.../TestCustomDns.groovy` | Groovy 测试用例 |

## 关键原则

1. **接口与实现分离**：扩展点定义在 `header/`，实现在 `plugin/`
2. **Spring XML 驱动**：所有 Bean 通过 XML 声明，不使用注解扫描
3. **PluginRegistry 自动发现**：实现 ExtensionPoint 的 Bean 会被自动收集；kvmagent 的 `PluginRegistry` 自动发现 `plugins/` 目录下的插件
4. **VirtualRouterAsyncHttpCallMsg**：与 VirtualRouter 通信的标准模式，通过 CloudBus 路由，而非直接调用 REST facade
5. **kvmagent 插件模式**：继承 `kvmagent.KvmAgent`，路由在 `start()` 中通过 `http_server.register_async_uri()` 注册，处理方法使用 `@kvmagent.replyerror` 装饰器
6. **Simulator 测试**：用模拟器验证完整链路，无需真实基础设施
