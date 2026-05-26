import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'

export default withMermaid(defineConfig({
  lang: 'zh-CN',
  title: 'ZStack 源码阅读',
  description: '从入门到深入，完整解读 ZStack IaaS 云管理平台源码',
  lastUpdated: true,
  cleanUrls: true,
  head: [
    ['meta', { name: 'theme-color', content: '#3c9779' }],
  ],
  themeConfig: {
    nav: [
      { text: '入门', link: '/guide/getting-started' },
      { text: '框架', link: '/framework/plugin-registry' },
      { text: '契约', link: '/contract/header-overview' },
      { text: '领域', link: '/domain/compute-overview' },
      { text: '网络', link: '/network/network-provider-model' },
      { text: '插件', link: '/plugin/kvm-plugin' },
      { text: 'Agent', link: '/agent/agent-architecture' },
      { text: '实战', link: '/practice/cross-repo-flow' },
      { text: '部署', link: '/deployment/overview' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: '入门篇',
          items: [
            { text: '00 - 环境准备与源码构建', link: '/guide/getting-started' },
            { text: '01 - 整体架构全景', link: '/guide/architecture' },
            { text: '02 - 启动流程详解', link: '/guide/boot-sequence' },
          ],
        },
      ],
      '/framework/': [
        {
          text: '框架篇',
          items: [
            { text: '03 - 插件框架与扩展点', link: '/framework/plugin-registry' },
            { text: '04 - CloudBus 消息总线', link: '/framework/cloudbus' },
            { text: '05 - FlowChain 工作流引擎', link: '/framework/flowchain' },
            { text: '06 - 数据库访问层', link: '/framework/database-facade' },
            { text: '07 - 级联删除机制', link: '/framework/cascade-facade' },
            { text: '08 - REST 与 API 框架', link: '/framework/rest-facade' },
            { text: '09 - 运行时配置体系', link: '/framework/global-config' },
            { text: '10 - 线程与并发模型', link: '/framework/thread-facade' },
          ],
        },
      ],
      '/contract/': [
        {
          text: '契约篇',
          items: [
            { text: '11 - 契约层设计哲学', link: '/contract/header-overview' },
            { text: '12 - AO/VO/Inventory 三层模型', link: '/contract/ao-vo-inventory' },
            { text: '13 - API 消息体系', link: '/contract/api-message' },
            { text: '14 - 状态机与事务表', link: '/contract/state-machine' },
            { text: '15 - 扩展点全景图', link: '/contract/extension-points' },
          ],
        },
      ],
      '/domain/': [
        {
          text: '领域篇',
          items: [
            { text: '16 - 计算域总览', link: '/domain/compute-overview' },
            { text: '17 - VM 创建全流程', link: '/domain/vm-lifecycle' },
            { text: '18 - VM 运维操作', link: '/domain/vm-operations' },
            { text: '19 - 主机管理', link: '/domain/host-management' },
            { text: '20 - 存储域', link: '/domain/storage-domain' },
            { text: '21 - 身份与权限', link: '/domain/identity-domain' },
          ],
        },
      ],
      '/network/': [
        {
          text: '网络篇',
          items: [
            { text: '22 - 网络服务提供者模型', link: '/network/network-provider-model' },
            { text: '23 - L2 网络实现与 Underlay', link: '/network/l2-network-realization' },
            { text: '24 - Overlay 网络与 Vxlan 隧道', link: '/network/overlay-vxlan' },
            { text: '25 - L3 网络与 IPAM', link: '/network/l3-network-ipam' },
            { text: '26 - Flat 网络提供者（分布式网关）', link: '/network/flat-provider' },
            { text: '27 - 虚拟路由器网关', link: '/network/virtual-router-gateway' },
            { text: '28 - EIP/VIP/NAT 网络服务', link: '/network/eip-vip-nat' },
            { text: '29 - 安全组', link: '/network/security-group' },
            { text: '30 - SDN 控制器集成', link: '/network/sdn-controller' },
            { text: '31 - VPC 架构与路由模型', link: '/network/vpc-architecture' },
            { text: '32 - 跨 VPC 网络路径', link: '/network/cross-vpc-network' },
            { text: '33 - 跨资源池网络路径', link: '/network/cross-zone-network' },
          ],
        },
      ],
      '/plugin/': [
        {
          text: '插件篇',
          items: [
            { text: '34 - KVM 虚拟化插件', link: '/plugin/kvm-plugin' },
            { text: '35 - Ceph 存储插件', link: '/plugin/ceph-plugin' },
            { text: '36 - Cloud-Init 插件', link: '/plugin/cloudinit' },
            { text: '37 - 其他插件概览', link: '/plugin/other-plugins' },
          ],
        },
      ],
      '/agent/': [
        {
          text: 'Agent 篇',
          items: [
            { text: '38 - Agent 通用架构', link: '/agent/agent-architecture' },
            { text: '39 - kvmagent 详解', link: '/agent/kvmagent' },
            { text: '40 - 虚拟路由器 Agent', link: '/agent/virtualrouter-agent' },
            { text: '41 - zstacklib 共享库', link: '/agent/zstacklib' },
            { text: '42 - CLI 工具', link: '/agent/zstackcli' },
          ],
        },
      ],
      '/dashboard/': [
        {
          text: 'Dashboard 篇',
          items: [
            { text: '43 - Dashboard 后端', link: '/dashboard/dashboard-backend' },
            { text: '44 - Dashboard 前端', link: '/dashboard/dashboard-frontend' },
          ],
        },
      ],
      '/practice/': [
        {
          text: '实战篇',
          items: [
            { text: '45 - 跨仓库调用链追踪', link: '/practice/cross-repo-flow' },
            { text: '46 - 测试体系与模拟器', link: '/practice/testing' },
            { text: '47 - 如何添加新功能', link: '/practice/adding-feature' },
            { text: '48 - 如何开发新插件', link: '/practice/adding-plugin' },
            { text: '49 - 调试技巧与陷阱', link: '/practice/debugging' },
          ],
        },
      ],
      '/deployment/': [
        {
          text: '部署篇',
          items: [
            { text: '50 - 部署架构总览', link: '/deployment/overview' },
            { text: '51 - 源码构建与打包', link: '/deployment/build-package' },
            { text: '52 - 数据库初始化与迁移', link: '/deployment/database-setup' },
            { text: '53 - 管理节点部署', link: '/deployment/management-node' },
            { text: '54 - Agent 部署与 Ansible', link: '/deployment/agent-deployment' },
            { text: '55 - Dashboard 部署', link: '/deployment/dashboard-deploy' },
            { text: '56 - 高可用与多管理节点', link: '/deployment/ha-cluster' },
            { text: '57 - 版本升级与数据迁移', link: '/deployment/upgrade' },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/zstackorg/zstack' },
    ],
    search: {
      provider: 'local',
      options: {
        locales: {
          root: {
            translations: {
              button: { buttonText: '搜索', buttonAriaLabel: '搜索文档' },
              modal: {
                noResultsText: '无法找到相关结果',
                resetButtonTitle: '清除查询条件',
                footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
              },
            },
          },
        },
      },
    },
    footer: {
      message: '基于 ZStack 5.4.0 源码分析',
    },
    outline: {
      label: '页面导航',
      level: [2, 3],
    },
    docFooter: {
      prev: '上一篇',
      next: '下一篇',
    },
    lastUpdated: {
      text: '最后更新于',
    },
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '菜单',
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
  },
  mermaid: {
    startOnLoad: true,
    theme: 'default',
  },
}))
