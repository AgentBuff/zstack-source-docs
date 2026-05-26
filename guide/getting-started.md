# 00 - 环境准备与源码构建

## 前置条件

在开始阅读和构建 ZStack 源码之前，需要准备以下环境：

| 依赖 | 版本要求 | 说明 |
|------|---------|------|
| JDK | 1.8 | ZStack 基于 Java 8 开发，不支持更高版本 |
| Maven | 3.x | 项目构建工具 |
| MySQL | 8.0+ | 元数据库，deploydb 脚本已适配 MySQL 8 |
| RabbitMQ | 3.x+ | CloudBus 消息中间件 |
| Python | 2.7 / 3.x | zstack-utility 中的 Agent 运行环境 |

> 源码位置：zstack/pom.xml 中定义了 `project.java.version` 为 `1.8`

## 克隆三个仓库

ZStack 由三个独立的 Git 仓库组成，分别承担不同职责：

```bash
# 核心管理节点 — Java
git clone https://github.com/zstackio/zstack.git

# 计算/存储节点 Agent — Python
git clone https://github.com/zstackio/zstack-utility.git

# Web UI — Flask + TypeScript
git clone https://github.com/zstackio/zstack-dashboard.git
```

## 构建 zstack 核心项目

### 全量构建

```bash
cd zstack
mvn -DskipTests clean install
```

该命令会编译全部 **24 个 Maven 模块**（含 `plugin/iscsi` 子模块），跳过测试，最终在 `build/` 目录下生成可部署的 WAR 包及启动脚本。

> 源码位置：zstack/pom.xml 第 29-54 行定义了所有 `<module>`

### Maven 模块一览

从根 `pom.xml` 中可以看到完整的模块列表：

```xml
<modules>
    <module>header</module>          <!-- 接口与 VO 定义 -->
    <module>core</module>            <!-- 框架层：CloudBus, FlowChain, PluginRegistry -->
    <module>utils</module>           <!-- 工具类 -->
    <module>compute</module>         <!-- 计算资源域 -->
    <module>network</module>         <!-- 网络资源域 -->
    <module>storage</module>         <!-- 存储资源域 -->
    <module>image</module>           <!-- 镜像管理 -->
    <module>identity</module>        <!-- 身份认证 -->
    <module>configuration</module>   <!-- 配置管理 -->
    <module>portal</module>          <!-- 启动入口与 Portal -->
    <module>plugin</module>          <!-- 插件聚合模块 -->
    <module>plugin/iscsi</module>    <!-- iSCSI 插件 -->
    <module>simulator</module>       <!-- 模拟器（测试用） -->
    <module>search</module>          <!-- 全文搜索 -->
    <module>console</module>         <!-- VNC 控制台 -->
    <module>tag</module>             <!-- 标签系统 -->
    <module>rest</module>            <!-- REST API 框架 -->
    <module>sdk</module>             <!-- SDK 生成 -->
    <module>testlib</module>         <!-- 测试库 -->
    <module>build</module>           <!-- 构建与打包 -->
    <module>externalservice</module> <!-- 外部服务 -->
    <module>longjob</module>         <!-- 长任务 -->
    <module>resourceconfig</module>  <!-- 资源配置 -->
    <module>abstraction</module>     <!-- 抽象层 -->
</modules>
```

### 模块依赖关系

模块之间存在严格的依赖层次：

```
header（纯接口/VO，无实现依赖）
  ↓
core（框架实现，依赖 header）
  ↓
compute / network / storage / identity / configuration / ...（域实现，依赖 core + header）
  ↓
plugin/*（具体插件，依赖对应域模块）
  ↓
portal（启动入口，聚合所有模块）
  ↓
build（打包部署）
```

`header` 模块只包含接口定义和 VO（Value Object），不依赖任何实现模块，这是 ZStack 模块解耦的关键设计。

## 核心依赖版本

从根 `pom.xml` 的 `<properties>` 和 `<dependencyManagement>` 中可以提取关键依赖版本：

> 源码位置：zstack/pom.xml 第 9-21 行

```xml
<properties>
    <project.java.version>1.8</project.java.version>
    <spring.framework.version>5.2.25.RELEASE</spring.framework.version>
    <spring.security.version>5.7.13</spring.security.version>
    <hibernate.version>5.3.26.Final</hibernate.version>
    <hibernate.search.version>5.10.12.Final</hibernate.search.version>
    <aspectj.version>1.8.9</aspectj.version>
    <aspectj.plugin.version>1.10</aspectj.plugin.version>
</properties>
```

| 依赖 | 版本 | 用途 |
|------|------|------|
| Spring Framework | 5.2.25.RELEASE | IoC 容器、事务管理、Web MVC |
| Spring Security | 5.7.13 | 认证授权 |
| Hibernate ORM | 5.3.26.Final | JPA 持久化 |
| Hibernate Search | 5.10.12.Final | 全文搜索（基于 Lucene + Infinispan） |
| AspectJ | 1.8.9 | 编译时织入（@AsyncSafe 等） |
| RabbitMQ Java Client | 5.14.2 | CloudBus 消息通信 |
| MySQL Connector | 8.2.0 | 数据库驱动 |
| Log4j 2 | 2.18.0 | 日志框架 |
| Guava | 32.1.2-jre | 通用工具库 |
| Jackson | 2.15.2 | JSON 序列化 |
| OkHttp | 4.9.3 | HTTP 客户端（Agent 通信） |
| C3P0 | 0.9.5.4 | 数据库连接池 |
| Groovy | 2.4.21 | 测试语言 |
| Lombok | 1.18.24 | 代码简化 |
| Infinispan | 10.1.8.Final | Hibernate Search 分布式索引 |
| Kryo | 5.0.0-RC2 | 高性能序列化 |
| Byte Buddy | 1.14.5 | 运行时字节码操作 |

## 部署数据库

```bash
mvn -Pdeploydb
```

该命令执行 `build/deploydb.sh` 脚本，完成以下工作：

> 源码位置：zstack/build/deploydb.sh

```bash
# 1. 创建 zstack 和 zstack_rest 两个数据库
DROP DATABASE IF EXISTS zstack;
CREATE DATABASE zstack;
DROP DATABASE IF EXISTS zstack_rest;
CREATE DATABASE zstack_rest;

# 2. 使用 Flyway 执行数据库迁移
flyway -outOfOrder=true -user=${user} -password=${password} -url=${url} migrate
```

数据库迁移文件位于 `conf/db/` 目录：
- `V0.6__schema.sql` — 初始 Schema
- `conf/db/upgrade/` — 增量升级脚本

Flyway 版本默认为 3.2.1，脚本会自动检测 MySQL 版本并适配 MySQL 8 的用户创建语法（`CREATE USER IF NOT EXISTS`）。

### 数据源配置

> 源码位置：zstack/conf/springConfigXml/DatabaseFacade.xml

ZStack 使用 C3P0 连接池，配置了两个数据源：

```xml
<!-- 主数据源：zstack 数据库 -->
<bean id="DbFacadeDataSource" class="com.mchange.v2.c3p0.ComboPooledDataSource">
    <property name="jdbcUrl" value="${DbFacadeDataSource.jdbcUrl:jdbc:mysql://localhost:3306/zstack}"/>
    <property name="user" value="${DbFacadeDataSource.user:root}"/>
    <property name="maxPoolSize" value="${DbFacadeDataSource.maxPoolSize:100}"/>
    <property name="initialPoolSize" value="10"/>
    <property name="acquireIncrement" value="50"/>
</bean>

<!-- 额外数据源：用于心跳检测等独立操作 -->
<bean id="ExtraDataSource" class="com.mchange.v2.c3p0.ComboPooledDataSource">
    <property name="maxPoolSize" value="5"/>
</bean>
```

`ExtraDataSource` 是一个独立的小连接池，专门用于心跳检测，避免心跳操作被主连接池的繁忙阻塞。

## Debug 模式启动

### 普通调试模式

```bash
mvn -pl build -P debug exec:exec -Ddebug
```

该命令执行 `build/debug.sh`，以 JDWP 调试模式启动管理节点：

> 源码位置：zstack/build/debug.sh

```bash
if [ x"$is_suspend" == x"true" ]; then
    java_optitons="-Xdebug -Xms256m -Xmx512m -XX:+HeapDumpOnOutOfMemoryError \
      -Xrunjdwp:transport=dt_socket,address=8787,server=y,suspend=y"
else
    java_optitons="-Xdebug -Xms256m -Xmx512m -XX:+HeapDumpOnOutOfMemoryError \
      -Xrunjdwp:transport=dt_socket,address=8787,server=y,suspend=n"
fi
```

- 调试端口：**8787**
- 默认 `suspend=n`，即不等待调试器连接
- 注意：debug.sh 中的入口类是 `com.zstack.server.Main`（商业版入口），开源版使用 `org.zstack.portal.main.Main`

### 挂起调试模式

```bash
mvn -pl build -P debug-suspend exec:exec -Ddebug-suspend
```

使用 `suspend=y`，JVM 启动后等待调试器连接才继续执行，适合调试启动流程。

## 启动脚本分析

构建完成后，`build/zstack` 是最终的生产启动脚本：

> 源码位置：zstack/build/zstack

```bash
#!/bin/bash

baseDir=`dirname $0`
libDir=$baseDir/lib
confDir=$baseDir/conf

buildClassPath() {
    jarList=`ls $libDir`
    for jar in $jarList
    do
        jarPath=$libDir/$jar
        classPath=$jarPath:$classPath
    done
    classPath=$classPath:$confDir
}

run() {
    java -cp $classPath org.zstack.portal.main.Main "$@"
}

main() {
    buildClassPath
    run "$@"
}

main "$@"
```

关键点：
- 入口类为 `org.zstack.portal.main.Main`（注意：源码中**没有**这个类的源文件，它是通过 WAR 部署到 Tomcat 后由 Servlet 容器调用的）
- 实际的启动入口是 `BootstrapWebListener` 和 `ComponentLoaderWebListener` 两个 `ServletContextListener`
- Classpath 包含 `lib/` 下所有 JAR 和 `conf/` 配置目录

## IDE 配置建议

### IntelliJ IDEA

1. **导入项目**：File → Open → 选择 zstack 根目录，IDEA 会自动识别 Maven 项目
2. **AspectJ 插件**：ZStack 使用 AspectJ 编译时织入，需要安装 IntelliJ AspectJ 插件
3. **关键注解**：
   - `@AsyncSafe` — 将同步方法转为异步调用
   - `@ExceptionSafe` — 吞掉异常并记录日志
   - `@MessageSafe` — 消息处理的安全包装
   - `@EncryptColumn` — 数据库字段加密存储
4. **AJDT 编译器**：Maven 构建时通过 `aspectj-maven-plugin`（版本 1.10）进行编译时织入，IDE 中需要配置 AJDT 编译器才能正确识别切面

### 常见构建问题

| 问题 | 解决方案 |
|------|---------|
| AspectJ 编译错误 | 确保使用 JDK 8，AspectJ 1.8.9 不支持更高版本 |
| QueryDSL Q 类型找不到 | 先执行 `mvn compile` 生成 Q 类型，它们在 `target/generated-sources/` 下 |
| VO_ 类报错 | `VO_` 是 QueryDSL 的 Q-type，不是 VO 的子类，需要编译后才能识别 |
| UUID 格式问题 | ZStack 使用 32 位无横线 UUID（`UUID.randomUUID().toString().replace("-", "")`），不是标准 36 位格式 |
| SyncLevel 死锁 | `AbstractService.getSyncLevel()` 默认返回 0（异步），设为 1 时若 Service 向自身发消息会死锁 |

### 测试运行

ZStack 的测试用 Groovy 编写，位于 `test/src/test/groovy/`：

```bash
# 运行全部测试
mvn test

# 运行单个测试类
mvn -pl test -Dtest=VmInstanceSubCase test
```

测试类继承 `SubCase`（来自 `testlib/` 模块），使用 JUnit 4 框架。JaCoCo 用于覆盖率统计。

## 项目目录结构总览

```
zstack/
├── header/           # 接口与 VO 定义（所有 IaaS 资源）
├── core/             # 框架层
│   └── src/main/java/org/zstack/core/
│       ├── cloudbus/       # CloudBus — RabbitMQ 消息总线
│       ├── workflow/       # FlowChain — 工作流引擎
│       ├── componentloader/ # PluginRegistry — 插件注册
│       ├── cascade/        # CascadeFacade — 级联删除
│       ├── db/             # DatabaseFacade — 数据库访问
│       ├── config/         # GlobalConfig — 运行时配置
│       ├── thread/         # ThreadFacade — 线程池
│       └── Platform.java   # 全局入口与工具方法
├── compute/          # 计算资源（VM、Host、Cluster、Zone）
├── network/          # 网络资源（L2、L3、EIP、VIP、SecurityGroup）
├── storage/          # 存储资源（PrimaryStorage、BackupStorage）
├── image/            # 镜像管理
├── identity/         # 身份认证与账户
├── configuration/    # 系统配置
├── portal/           # 启动入口
│   └── src/main/java/org/zstack/portal/
│       ├── managementnode/  # BootstrapWebListener, ManagementNodeManagerImpl
│       └── apimediator/     # ApiMediatorImpl — API 消息路由
├── plugin/           # 插件聚合
│   ├── kvm/          # KVM Hypervisor 插件
│   ├── ceph/         # Ceph 存储插件
│   ├── virtualrouter/ # 虚拟路由器插件
│   ├── securityGroup/ # 安全组插件
│   ├── eip/          # 弹性 IP 插件
│   └── ...           # 更多插件
├── conf/
│   ├── springConfigXml/  # Spring Bean 配置（91+ XML 文件）
│   ├── serviceConfig/    # API 消息路由（62 XML 文件）
│   ├── globalConfig/     # 运行时可变全局配置
│   └── db/               # 数据库 Schema 与迁移脚本
├── build/            # 构建与部署
└── test/             # 集成测试（Groovy）
```
