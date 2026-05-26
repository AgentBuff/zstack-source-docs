# 如何添加新功能

本文以"添加 VM 控制台截图功能"为例，演示在 ZStack 中添加新功能的完整流程。该功能在 ZStack 源码中已有实现，本文参照实际代码讲解。

## 功能需求

添加一个 API，允许用户获取 VM 的控制台截图（screenshot），返回 base64 编码的 PNG 图片。

## 第 1 步：定义 API 消息

在 `header/` 模块中定义 API 消息和回复：

`zstack/header/src/main/java/org/zstack/header/vm/APITakeVmConsoleScreenshotMsg.java`

```java
package org.zstack.header.vm;

@RestRequest(
    path = "/vm-instances/{uuid}/actions",
    isAction = true,
    method = HttpMethod.PUT,
    responseClass = APITakeVmConsoleScreenshotEvent.class
)
public class APITakeVmConsoleScreenshotMsg extends APIMessage implements VmInstanceMessage {
    @APIParam(resourceType = VmInstanceVO.class, checkAccount = true)
    private String uuid;

    public String getUuid() { return uuid; }
    public void setUuid(String uuid) { this.uuid = uuid; }
}
```

`zstack/header/src/main/java/org/zstack/header/vm/APITakeVmConsoleScreenshotEvent.java`

```java
package org.zstack.header.vm;

public class APITakeVmConsoleScreenshotEvent extends APIEvent {
    private String imageData;

    public String getImageData() { return imageData; }
    public void setImageData(String imageData) { this.imageData = imageData; }
}
```

> **注**：ZStack 的 action 风格 API 统一使用 `path = "/vm-instances/{uuid}/actions"`、`method = HttpMethod.PUT`、`isAction = true` 的模式（如 `APIStartVmInstanceMsg`、`APIStopVmInstanceMsg`、`APIRebootVmInstanceMsg` 均如此）。创建类 API 则使用 `path = "/vm-instances"`、`method = HttpMethod.POST`。

## 第 2 步：注册 API 路由

在 `conf/serviceConfig/` 下添加路由配置：

`zstack/conf/serviceConfig/vmInstance.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<service>
    <id>vmInstance</id>
    <interceptor>VmInstanceApiInterceptor</interceptor>
    <!-- 已有消息路由 ... -->
    <message>
        <name>org.zstack.header.vm.APITakeVmConsoleScreenshotMsg</name>
    </message>
</service>
```

这个 XML 告诉 CloudBus：`APITakeVmConsoleScreenshotMsg` 由 `vmInstance` 服务处理，拦截器为 `VmInstanceApiInterceptor`。注意 service config XML 只做消息路由，REST 路径和 HTTP 方法由 `@RestRequest` 注解决定。

## 第 3 步：实现 API 拦截器

在 VmInstanceApiInterceptor 中添加校验逻辑：

`zstack/compute/src/main/java/org/zstack/compute/vm/VmInstanceApiInterceptor.java`

```java
private void validate(APITakeVmConsoleScreenshotMsg msg) {
    VmInstanceVO vm = findByUuid(msg.getUuid());
    if (vm == null) {
        throw new ApiMessageInterceptionException(
            argerr("vm instance[uuid:%s] not found", msg.getUuid()));
    }
    if (vm.getState() != VmInstanceState.Running) {
        throw new ApiMessageInterceptionException(
            argerr("vm instance[uuid:%s] is not running, current state:%s",
                   msg.getUuid(), vm.getState()));
    }
}
```

## 第 4 步：定义 Hypervisor 层消息

ZStack 的 KVM 插件通过 `KVMHostAsyncHttpCallMsg` 向 kvmagent 发送 HTTP 请求。先定义 Hypervisor 层的消息和回复：

`zstack/header/src/main/java/org/zstack/header/vm/TakeVmConsoleScreenshotMsg.java`

```java
package org.zstack.header.vm;

public class TakeVmConsoleScreenshotMsg extends NeedReplyMessage {
    private String vmInstanceUuid;
    private String hostUuid;

    public String getVmInstanceUuid() { return vmInstanceUuid; }
    public void setVmInstanceUuid(String vmInstanceUuid) { this.vmInstanceUuid = vmInstanceUuid; }
    public String getHostUuid() { return hostUuid; }
    public void setHostUuid(String hostUuid) { this.hostUuid = hostUuid; }
}
```

`zstack/header/src/main/java/org/zstack/header/vm/TakeVmConsoleScreenshotReply.java`

```java
package org.zstack.header.vm;

public class TakeVmConsoleScreenshotReply extends MessageReply {
    private String imageData;

    public String getImageData() { return imageData; }
    public void setImageData(String imageData) { this.imageData = imageData; }
}
```

> **注**：实际源码中，`TakeVmConsoleScreenshotMsg` 是一个独立的 Hypervisor 层消息，由 VmInstanceBase 发送到 KVMHost 处理，而非通过 ExtensionPoint 扩展点。这比虚构的 `GetVmConsoleScreenshotExtensionPoint` 更简单直接。

## 第 5 步：在 VmInstanceBase 中处理 API 消息

`zstack/compute/src/main/java/org/zstack/compute/vm/VmInstanceBase.java`

```java
private void handleApiMessage(APIMessage msg) {
    if (msg instanceof APITakeVmConsoleScreenshotMsg) {
        handle((APITakeVmConsoleScreenshotMsg) msg);
    }
    // ... 其他消息处理
}

private void handle(APITakeVmConsoleScreenshotMsg msg) {
    TakeVmConsoleScreenshotMsg tmsg = new TakeVmConsoleScreenshotMsg();
    tmsg.setVmInstanceUuid(self.getUuid());
    tmsg.setHostUuid(self.getHostUuid());
    bus.makeTargetServiceIdByResourceUuid(tmsg, HostConstant.SERVICE_ID, self.getHostUuid());
    bus.send(tmsg, new CloudBusCallBack(msg) {
        @Override
        public void run(MessageReply reply) {
            APITakeVmConsoleScreenshotEvent evt =
                new APITakeVmConsoleScreenshotEvent(msg.getId());
            if (!reply.isSuccess()) {
                evt.setError(reply.getError());
            } else {
                TakeVmConsoleScreenshotReply r = (TakeVmConsoleScreenshotReply) reply;
                evt.setImageData(r.getImageData());
            }
            bus.publish(evt);
        }
    });
}
```

> **注**：实际源码中，VmInstanceBase 通过 CloudBus 将 `TakeVmConsoleScreenshotMsg` 发送到 KVMHost 所在的 Service，而非通过 ExtensionPoint。这是 ZStack 中 Hypervisor 操作的标准模式。

## 第 6 步：在 KVM 插件中实现

`zstack/plugin/kvm/src/main/java/org/zstack/kvm/KVMHost.java`

```java
private void handle(TakeVmConsoleScreenshotMsg msg) {
    TakeVmConsoleScreenshotReply reply = new TakeVmConsoleScreenshotReply();
    thdf.singleFlightSubmit(new SingleFlightTask(msg)
            .setSyncSignature(String.format("take-vm-%s-console-screenshot-on-host-%s",
                msg.getVmInstanceUuid(), msg.getHostUuid()))
            .run(completion -> {
                takeVmConsoleScreenshot(msg.getVmInstanceUuid(), msg.getHostUuid(),
                    new ReturnValueCompletion<TakeVmConsoleScreenshotRsp>(completion) {
                        @Override
                        public void success(TakeVmConsoleScreenshotRsp returnValue) {
                            completion.success(returnValue.getImageData());
                        }

                        @Override
                        public void fail(ErrorCode errorCode) {
                            completion.fail(errorCode);
                        }
                    });
            })
            .done(result -> {
                if (result.isSuccess()) {
                    String returnValue = (String) result.getResult();
                    reply.setImageData(returnValue);
                } else {
                    reply.setError(result.getErrorCode());
                }
                bus.reply(msg, reply);
            })
    );
}

private void takeVmConsoleScreenshot(String vmInstanceUuid, String hostUuid,
        ReturnValueCompletion<TakeVmConsoleScreenshotRsp> completion) {
    TakeVmConsoleScreenshotCmd cmd = new TakeVmConsoleScreenshotCmd();
    cmd.setVmUuid(vmInstanceUuid);

    KVMHostAsyncHttpCallMsg kmsg = new KVMHostAsyncHttpCallMsg();
    kmsg.setCommand(cmd);
    kmsg.setPath(KVMConstant.TAKE_VM_CONSOLE_SCREENSHOT_PATH);
    kmsg.setHostUuid(hostUuid);
    bus.makeTargetServiceIdByResourceUuid(kmsg, HostConstant.SERVICE_ID, hostUuid);
    bus.send(kmsg, new CloudBusCallBack(completion) {
        @Override
        public void run(MessageReply reply) {
            if (!reply.isSuccess()) {
                completion.fail(reply.getError());
                return;
            }

            KVMHostAsyncHttpCallReply r = reply.castReply();
            TakeVmConsoleScreenshotRsp rsp = r.toResponse(TakeVmConsoleScreenshotRsp.class);
            if (!rsp.isSuccess()) {
                completion.fail(operr(rsp.getError()));
            } else {
                completion.success(r.toResponse(TakeVmConsoleScreenshotRsp.class));
            }
        }
    });
}
```

> **注**：KVM 插件通过 `KVMHostAsyncHttpCallMsg` 发送命令到 kvmagent，这是 ZStack 中 KVM 操作的标准模式。`KVMHostAsyncHttpCallMsg` 内部会通过 `RESTFacade.asyncJsonPost()` 将命令以 HTTP JSON 方式发送到 kvmagent 的 HTTP 服务器。`singleFlightSubmit` 用于防止同一 VM 的并发截图请求。

## 第 7 步：定义 Agent 命令

`zstack/plugin/kvm/src/main/java/org/zstack/kvm/KVMAgentCommands.java`（内部类）

```java
public static class TakeVmConsoleScreenshotCmd extends AgentCommand {
    @GrayVersion(value = "5.0.0")
    private String vmUuid;

    public String getVmUuid() { return vmUuid; }
    public void setVmUuid(String vmUuid) { this.vmUuid = vmUuid; }
}

public static class TakeVmConsoleScreenshotRsp extends AgentResponse {
    @GrayVersion(value = "5.0.0")
    private String imageData;

    public String getImageData() { return imageData; }
    public void setImageData(String imageData) { this.imageData = imageData; }
}
```

> **注**：实际源码中，Cmd/Rsp 定义为 `KVMAgentCommands` 的内部类，而非独立文件。Cmd 字段为 `vmUuid`（不是 `vmInstanceUuid` + `vmName`），Rsp 字段为 `imageData`（不是 `screenshot`）。`@GrayVersion` 注解用于灰度发布兼容性。

## 第 8 步：添加 KVM 常量

`zstack/plugin/kvm/src/main/java/org/zstack/kvm/KVMConstant.java`

```java
public interface KVMConstant {
    // 已有常量 ...
    String TAKE_VM_CONSOLE_SCREENSHOT_PATH = "/vm/console/screenshot";
}
```

> **注**：实际路径为 `/vm/console/screenshot`，不是 `/kvm/getconsolescreenshot`。ZStack 的 KVM agent 路径统一以 `/vm/` 为前缀。

## 第 9 步：在 kvmagent 中实现

`zstack-utility/kvmagent/kvmagent/plugins/vm_plugin.py`

首先定义响应类：

```python
class TakeVmConsoleScreenshotRsp(kvmagent.AgentResponse):
    def __init__(self):
        super(TakeVmConsoleScreenshotRsp, self).__init__()
        self.imageData = None
```

在 `VmPlugin` 类中定义路径常量和处理方法：

```python
class VmPlugin(kvmagent.KvmAgent):
    TAKE_VM_CONSOLE_SCREENSHOT_PATH = "/vm/console/screenshot"

    @kvmagent.replyerror
    def take_console_screenshot(self, req):
        cmd = jsonobject.loads(req[http.REQUEST_BODY])
        rsp = TakeVmConsoleScreenshotRsp()

        @LibvirtAutoReconnect
        def create_stream(conn):
            return conn.newStream()

        def read_stream_to_file(stream, file_path):
            with open(file_path, 'wb') as f:
                for data in iter(lambda: stream.recv(262120), b''):
                    f.write(data)

        stream = create_stream()
        if stream is None:
            rsp.success = False
            rsp.error = "failed to create libvirt stream"
            return jsonobject.dumps(rsp)

        tmp_ppm = "/tmp/%s.ppm" % cmd.vmUuid
        tmp_img = "/tmp/%s.png" % cmd.vmUuid
        try:
            vm = get_vm_by_uuid(cmd.vmUuid)
            vm.domain.screenshot(stream, 0)
            read_stream_to_file(stream, tmp_ppm)

            tmp_img = image.convert_image(tmp_ppm)
            with open(tmp_img, 'rb') as f:
                img_data = f.read()

            rsp.imageData = 'data:image/png;base64,' + base64.b64encode(img_data).decode('utf-8')
        except Exception as e:
            logger.warn(linux.get_exception_stacktrace())
            rsp.error = str(e)
            rsp.success = False
        finally:
            stream.finish()
            linux.rm_file_force(tmp_ppm)
            linux.rm_file_force(tmp_img)
        return jsonobject.dumps(rsp)
```

在 `VmPlugin.start()` 方法中注册路由：

```python
def start(self):
    http_server = kvmagent.get_http_server()
    # ... 其他路由注册 ...
    http_server.register_async_uri(self.TAKE_VM_CONSOLE_SCREENSHOT_PATH, self.take_console_screenshot)
```

> **注**：实际 kvmagent 的关键模式：
> - 插件类继承 `kvmagent.KvmAgent`，路由在 `start()` 方法中通过 `http_server.register_async_uri(path, handler)` 注册
> - 处理方法使用 `@kvmagent.replyerror` 装饰器自动捕获异常
> - 请求体通过 `req[http.REQUEST_BODY]` 获取，而非 `req.body`
> - 使用 `get_vm_by_uuid()` 获取 `Vm` 对象，通过 `vm.domain`（libvirt domain）操作 VM，而非 `shell.run('virsh ...')`
> - 截图流程：libvirt stream → PPM 文件 → `image.convert_image()` 转 PNG → base64 编码

## 第 10 步：注册 Spring Bean

`zstack/plugin/kvm/src/main/resources/Kvm.xml`

```xml
<!-- KVMHost 已有 Bean 声明，无需新增 -->
```

KVMHost 已在 Spring XML 中声明，新增的 `handle(TakeVmConsoleScreenshotMsg)` 方法会自动被 CloudBus 路由。

## 第 11 步：编写测试

`zstack/test/src/test/groovy/org/zstack/test/kvm/TestTakeVmConsoleScreenshot.groovy`

```groovy
class TestTakeVmConsoleScreenshot extends SubCase {
    EnvSpec env

    @Override
    void setSpringSpec() {
        _springSpec = makeSpring {
            includeCoreServices()
            kvm()
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

        def vm = createVmInstance {
            name = "test-vm"
            instanceOfferingUuid = env.specByName("off").inventory.uuid
            imageUuid = env.specByName("img").inventory.uuid
            l3NetworkUuids = [env.specByName("l3").inventory.uuid] as List
            defaultL3NetworkUuid = env.specByName("l3").inventory.uuid
            zoneUuid = env.specByName("z1").inventory.uuid
        }

        env.simulator("vm/console/screenshot") { HttpEntity<String> e ->
            return httpSuccess([imageData: "data:image/png;base64,iVBORw0KGgo..."])
        }

        def result = takeVmConsoleScreenshot { uuid = vm.inventory.uuid }
        assert result.imageData != null
        assert result.imageData.startsWith("data:image/png;base64,")
    }

    @Override
    void clean() {
        env.delete()
    }
}
```

> **注**：Simulator 路径使用 `/vm/console/screenshot`（与 KVMConstant 中定义的路径一致），返回字段为 `imageData`。

## 涉及文件清单

| 步骤 | 文件 | 仓库 |
|------|------|------|
| API 消息 | `header/.../APITakeVmConsoleScreenshotMsg.java` | zstack |
| API 回复 | `header/.../APITakeVmConsoleScreenshotEvent.java` | zstack |
| Hypervisor 消息 | `header/.../TakeVmConsoleScreenshotMsg.java` | zstack |
| Hypervisor 回复 | `header/.../TakeVmConsoleScreenshotReply.java` | zstack |
| 路由配置 | `conf/serviceConfig/vmInstance.xml` | zstack |
| API 拦截 | `compute/.../VmInstanceApiInterceptor.java` | zstack |
| 消息处理 | `compute/.../VmInstanceBase.java` | zstack |
| KVM 实现 | `plugin/kvm/.../KVMHost.java` | zstack |
| Agent 命令 | `plugin/kvm/.../KVMAgentCommands.java`（内部类） | zstack |
| 常量 | `plugin/kvm/.../KVMConstant.java` | zstack |
| Agent 实现 | `kvmagent/plugins/vm_plugin.py` | zstack-utility |
| 测试 | `test/.../TestTakeVmConsoleScreenshot.groovy` | zstack |

## 关键模式总结

1. **header 先行**：API 消息和 Hypervisor 层消息定义在 `header/` 模块，与实现解耦
2. **CloudBus 路由**：VmInstanceBase 通过 CloudBus 将 Hypervisor 操作消息发送到对应 Host 的 Service，而非通过 ExtensionPoint
3. **KVMHostAsyncHttpCallMsg**：KVM 插件通过此消息类型将命令发送到 kvmagent，内部使用 `RESTFacade.asyncJsonPost()` 发送 HTTP JSON 请求
4. **Agent 命令对**：Cmd + Rsp 定义为 `KVMAgentCommands` 的内部类，通过 `KVMHostAsyncHttpCallMsg` 传递
5. **kvmagent 模式**：插件继承 `kvmagent.KvmAgent`，路由在 `start()` 中通过 `http_server.register_async_uri()` 注册，处理方法使用 `@kvmagent.replyerror` 装饰器，请求体通过 `req[http.REQUEST_BODY]` 获取
6. **Simulator 测试**：用模拟器替代真实 Agent，路径与 KVMConstant 中定义一致
