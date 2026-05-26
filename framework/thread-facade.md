# 10 - 线程与并发模型

ZStack 管理节点是一个高并发的消息驱动系统。每个 API 请求、每条 CloudBus 消息、每个定时任务都需要线程来执行。`ThreadFacadeImpl` 和 `DispatchQueueImpl` 共同构成了 ZStack 的线程与并发基础设施——前者管理线程池和定时任务，后者实现 SingleFlight、链式任务队列和同步任务队列三大并发原语。

## ThreadFacadeImpl —— 线程池管理

> 源码位置：zstack/core/src/main/java/org/zstack/core/thread/ThreadFacadeImpl.java

### 类声明与核心数据结构

```java
public class ThreadFacadeImpl implements ThreadFacade, ThreadFactory, RejectedExecutionHandler, ThreadFacadeMXBean {
    private static final CLogger _logger = CLoggerImpl.getLogger(ThreadFacadeImpl.class);

    private final Map<PeriodicTask, ScheduledFuture<?>> _periodicTasks = new ConcurrentHashMap<PeriodicTask, ScheduledFuture<?>>();
    private final Map<CancelablePeriodicTask, ScheduledFuture<?>> cancelablePeriodicTasks = new ConcurrentHashMap<CancelablePeriodicTask, ScheduledFuture<?>>();
    private static final AtomicInteger seqNum = new AtomicInteger(0);
    private ScheduledThreadPoolExecutorExt _pool;
    private ScheduledThreadPoolExecutorExt _syncpool;
    private ConcurrentHashMap<String, ScheduledThreadPoolExecutorExt> pools = new ConcurrentHashMap<>();
    private DispatchQueue dpq;
    private final TimerPool timerPool = new TimerPool(5);

    @Autowired
    private JmxFacade jmxf;
    @Autowired
    private PluginRegistry pluginRegistry;
}
```

**关键设计**：
- `ThreadFacadeImpl` 实现了 `ThreadFactory` 接口，自己负责线程创建和命名
- 实现了 `RejectedExecutionHandler` 接口，自己处理任务拒绝策略
- 实现了 `ThreadFacadeMXBean` 接口，支持 JMX 监控
- **不实现 `Component` 接口**——Spring XML 中有明确注释："don't declare Component extension, it's specially handled"
- `ThreadFacade` 接口继承了 `Component`，但 `ThreadFacadeImpl` 通过 Spring 的 `default-init-method="init"` 和 `default-destroy-method="destroy"` 管理生命周期

### ScheduledThreadPoolExecutorExt

> 源码位置：zstack/core/src/main/java/org/zstack/core/thread/ScheduledThreadPoolExecutorExt.java

ZStack 没有使用标准的 `ThreadPoolExecutor` 或 `ScheduledExecutorService`，而是扩展了 `ScheduledThreadPoolExecutor`：

```java
public class ScheduledThreadPoolExecutorExt extends ScheduledThreadPoolExecutor {
    List<ThreadAroundHook> _hooks = new ArrayList<ThreadAroundHook>(8);

    public ScheduledThreadPoolExecutorExt(int corePoolSize, ThreadFactory threadFactory, RejectedExecutionHandler handler) {
        super(corePoolSize, threadFactory, handler);
        this.setMaximumPoolSize(corePoolSize);
    }

    @Override
    protected void beforeExecute(Thread t, Runnable r) {
        ThreadContext.clearMap();
        ThreadContext.clearStack();

        List<ThreadAroundHook> tmpHooks;
        synchronized (_hooks) {
            tmpHooks = new ArrayList<ThreadAroundHook>(_hooks);
        }

        for (ThreadAroundHook hook : tmpHooks) {
            hook.beforeExecute(t, r);
        }
    }

    @Override
    protected void afterExecute(Runnable r, Throwable t) {
        ThreadContext.clearMap();
        ThreadContext.clearStack();

        List<ThreadAroundHook> tmpHooks;
        synchronized (_hooks) {
            tmpHooks = new ArrayList<ThreadAroundHook>(_hooks);
        }

        for (ThreadAroundHook hook : tmpHooks) {
            hook.afterExecute(r, t);
        }
    }
}
```

**关键特性**：
- 每次任务执行前后清理 Log4j `ThreadContext`，防止日志上下文泄漏
- 支持 `ThreadAroundHook` 扩展点，可在任务执行前后插入自定义逻辑
- `setMaximumPoolSize(corePoolSize)` 确保线程池大小固定

### 线程池初始化

```java
public void init() {
    int totalThreadNum = ThreadGlobalProperty.MAX_THREAD_NUM;
    if (totalThreadNum < 10) {
        _logger.warn(String.format("ThreadFacade.maxThreadNum is configured to %s, which is too small for running zstack. Change it to 10", ThreadGlobalProperty.MAX_THREAD_NUM));
        totalThreadNum = 10;
    }
    _pool = new ScheduledThreadPoolExecutorExt(totalThreadNum, this, this);
    _syncpool = new ScheduledThreadPoolExecutorExt(getSyncThreadNum(totalThreadNum), this, this);
    _logger.debug(String.format("create ThreadFacade with max thread number:%s", totalThreadNum));
    dpq = new DispatchQueueImpl();

    jmxf.registerBean("ThreadFacade", this);
}
```

**关键设计**：
- 两个线程池：`_pool`（主线程池）和 `_syncpool`（同步任务线程池）
- 线程池类型是 `ScheduledThreadPoolExecutorExt`，同时支持定时任务和普通任务提交
- 构造参数 `(corePoolSize, this, this)` 中两个 `this` 分别作为 `ThreadFactory` 和 `RejectedExecutionHandler`
- 同步线程池大小为 `totalThreadNum / 3`，最小 150
- 注册 JMX Bean 支持运行时监控

### ThreadFactory 实现

```java
@Override
public Thread newThread(@Nonnull Runnable arg0) {
    return new Thread(arg0, "zs-thread-" + seqNum.getAndIncrement());
}
```

线程名前缀为 `"zs-thread-"`，带自增编号，便于日志排查。

### RejectedExecutionHandler 实现

```java
@Override
public void rejectedExecution(Runnable arg0, ThreadPoolExecutor arg1) {
    _logger.warn("Task " + arg0.getClass().getSimpleName() + " got rejected by ThreadPool, the pool looks full");
}
```

拒绝策略仅记录警告日志，**不使用 `CallerRunsPolicy`**——被拒绝的任务会被丢弃。

### start() —— 注册独立线程池

```java
@Override
public boolean start() {
    int totalThreadNum = ThreadGlobalProperty.MAX_THREAD_NUM;

    List<ThreadPool> poolList = new ArrayList<>();
    for (ThreadPoolRegisterExtensionPoint ext : pluginRegistry.getExtensionList(ThreadPoolRegisterExtensionPoint.class)) {
        List<ThreadPool> threadPools = ext.registerThreadPool();
        if (CollectionUtils.isEmpty(threadPools)) {
            throw new CloudRuntimeException("Empty thread pool registration is not supported");
        }

        List<ThreadPool> noSignaturePools = threadPools.stream().filter(pool -> pool.getSyncSignature() == null).collect(Collectors.toList());
        if (!CollectionUtils.isEmpty(noSignaturePools)) {
            throw new CloudRuntimeException("Thread pool registration do not allow empty syncSignature");
        }

        List<String> distinctPoolNames = threadPools.stream().map(ThreadPool::getSyncSignature).distinct().collect(Collectors.toList());
        if (distinctPoolNames.size() < threadPools.size()) {
            throw new CloudRuntimeException(String.format("Duplicate thread pool name detected %s", threadPools.stream().map(ThreadPool::getSyncSignature).collect(Collectors.toList())));
        }

        List<ThreadPool> nameDuplicatePool = poolList.stream().filter(pool -> threadPools.stream().anyMatch(newPool -> pool.getSyncSignature().equals(newPool.getSyncSignature()))).collect(Collectors.toList());
        if (!CollectionUtils.isEmpty(nameDuplicatePool)) {
            throw new CloudRuntimeException(String.format("Duplicate thread pool name with existing pool %s", nameDuplicatePool.stream().map(ThreadPool::getSyncSignature).collect(Collectors.toList())));
        }
        poolList.addAll(threadPools);
    }

    _logger.debug(String.format("Load separate thread pool: %d", poolList.size()));
    int separatedThreadNum = poolList.stream().mapToInt(ThreadPool::getThreadNum).sum();
    int internalThreadNum = totalThreadNum - separatedThreadNum;
    if (internalThreadNum < 10) {
        _logger.warn(String.format("ThreadFacade.maxThreadNum is configured to %s." +
                        " Remaining thread number for internal pools is %d, which is too" +
                        " small for running zstack. Change it to 10",
                internalThreadNum,
                ThreadGlobalProperty.MAX_THREAD_NUM));
        internalThreadNum = 10;
        totalThreadNum = separatedThreadNum + internalThreadNum;
    }

    poolList.forEach(this::initThreadPool);

    return true;
}

private void initThreadPool(ThreadPool pool) {
    ScheduledThreadPoolExecutorExt threadExt = new ScheduledThreadPoolExecutorExt(pool.getThreadNum(), this, this);
    pools.put(pool.getSyncSignature(), threadExt);
}
```

`start()` 方法通过 `ThreadPoolRegisterExtensionPoint` 扩展点收集各模块注册的独立线程池，从 `MAX_THREAD_NUM` 中分配线程数。注册的线程池存储在 `pools` Map 中，按 `syncSignature` 索引。

### submit —— 提交异步任务

```java
public static class Worker<T> implements Callable<T> {
    private final Task<T> _task;

    public Worker(Task<T> task) {
        _task = task;
    }

    @Override
    public T call() throws Exception {
        try {
            return _task.call();
        } catch (Exception e) {
            _logger.warn(_task.getName() + " throws out an unhandled exception, this thread will terminate immediately", e);
            throw e;
        } catch (Throwable t) {
            _logger.warn(_task.getName() + " throws out an unhandled throwable, this thread will terminate immediately", t);
            throw new CloudRuntimeException(_task.getName() + " throws out an unhandled throwable, this thread will terminate immediately", t);
        }
    }
}

@Override
public <T> Future<T> submit(Task<T> task) {
    _logger.trace(String.format("submit task: %s", task.getName()));
    return _pool.submit(new Worker<T>(task));
}

public <T> Future<T> submitSyncPool(Task<T> task) {
    return _syncpool.submit(new Worker<T>(task));
}

@Override
public <T> Future<T> submitTargetPool(Task<T> task, String signature) {
    ScheduledThreadPoolExecutorExt executorExt = pools.getOrDefault(signature, _syncpool);
    return executorExt.submit(new Worker<>(task));
}
```

**关键设计**：
- `Task<T>` 接口继承 `Callable<T>`，额外提供 `getName()` 方法
- `Worker<T>` 内部类包装 `Task`，捕获未处理异常并记录日志
- `submit()` 返回 `Future<T>`，而非 `FutureCompletion`
- `submitTargetPool()` 支持将任务提交到指定签名的独立线程池，找不到时回退到 `_syncpool`

### syncSubmit —— 提交同步任务

同步任务通过 `DispatchQueue` 的同步队列执行，保证相同 `syncSignature` 的任务串行：

```java
@Override
public <T> Future<T> syncSubmit(SyncTask<T> task) {
    return dpq.syncSubmit(task);
}
```

### chainSubmit —— 提交链式任务

```java
@Override
public Future<Void> chainSubmit(ChainTask task) {
    return dpq.chainSubmit(task);
}
```

### singleFlightSubmit —— 提交 SingleFlight 任务

```java
@Override
public <T> Future<T> singleFlightSubmit(SingleFlightTask task) {
    return dpq.singleFlightSubmit(task);
}
```

### 定时任务

```java
@Override
public Future<Void> submitPeriodicTask(final PeriodicTask task, long delay) {
    assert task.getInterval() != 0;
    assert task.getTimeUnit() != null;

    ScheduledFuture<Void> ret = (ScheduledFuture<Void>) _pool.scheduleAtFixedRate(new Runnable() {
        public void run() {
            try {
                task.run();
            } catch (Throwable e) {
                _logger.warn("An unhandled exception happened during executing periodic task: " + task.getName() + ", cancel it", e);
                final Map<PeriodicTask, ScheduledFuture<?>> periodicTasks = getPeriodicTasks();
                final ScheduledFuture<?> ft = periodicTasks.get(task);
                if (ft != null) {
                    ft.cancel(true);
                    periodicTasks.remove(task);
                } else {
                    _logger.warn("Not found feature for task " + task.getName()
                            + ", the exception happened too soon, will try to cancel the task next time the exception happens");
                }
            }
        }
    }, delay, task.getInterval(), task.getTimeUnit());
    _periodicTasks.put(task, ret);
    return ret;
}

@Override
public Future<Void> submitCancelablePeriodicTask(final CancelablePeriodicTask task, long delay) {
    ScheduledFuture<Void> ret = (ScheduledFuture<Void>) _pool.scheduleAtFixedRate(new Runnable() {
        private void cancelTask() {
            ScheduledFuture<?> ft = cancelablePeriodicTasks.get(task);
            if (ft != null) {
                ft.cancel(true);
                cancelablePeriodicTasks.remove(task);
            } else {
                _logger.warn("cannot find feature for task " + task.getName()
                        + ", the exception happened too soon, will try to cancel the task next time the exception happens");
            }
        }

        public void run() {
            try {
                boolean cancel = task.run();
                if (cancel) {
                    cancelTask();
                }
            } catch (Throwable e) {
                _logger.warn("An unhandled exception happened during executing periodic task: " + task.getName() + ", cancel it", e);
                cancelTask();
            }
        }
    }, delay, task.getInterval(), task.getTimeUnit());
    cancelablePeriodicTasks.put(task, ret);
    return ret;
}
```

**关键设计**：
- 周期任务通过 `_pool.scheduleAtFixedRate()` 调度
- `PeriodicTask`：异常时自动取消任务
- `CancelablePeriodicTask`：任务返回 `true` 时主动取消，异常时也自动取消
- 所有周期任务的 `ScheduledFuture` 保存在 Map 中，支持外部取消

### TimeoutTask 与 TimerTask

```java
public interface TimeoutTaskReceipt {
    boolean cancel();
}

@Override
public TimeoutTaskReceipt submitTimeoutTask(Runnable task, TimeUnit unit, long delay) {
    final TimerWrapper timer = timerPool.getTimer();

    class TimerTaskWorker extends java.util.TimerTask implements TimeoutTaskReceipt {
        @Override
        @AsyncThread
        public void run() {
            try {
                task.run();
            } catch (Throwable t) {
                _logger.warn(String.format("Unhandled exception happened when running %s", task.getClass().getName()), t);
            } finally {
                this.cancel();
            }
        }

        @Override
        public boolean cancel() {
            boolean ret = super.cancel();
            timer.notifyCancel();
            return ret;
        }
    }

    TimerTaskWorker worker = new TimerTaskWorker();
    timer.schedule(worker, unit.toMillis(delay));
    return worker;
}
```

**关键设计**：
- 使用 `TimerPool`（5 个 `Timer` 的池）而非 `ScheduledExecutorService` 来执行超时任务
- `TimerPool` 使用轮询方式分配 `Timer`，避免单 `Timer` 瓶颈
- `TimerWrapper` 在取消任务达到阈值时自动 `purge()`，避免内存泄漏
- `TimeoutTaskReceipt` 接口支持取消定时任务

### ThreadAroundHook

```java
@Override
public void registerHook(ThreadAroundHook hook) {
    _pool.registerHook(hook);
    _syncpool.registerHook(hook);
}

@Override
public void unregisterHook(ThreadAroundHook hook) {
    _pool.unregisterHook(hook);
    _syncpool.unregisterHook(hook);
}
```

`ThreadAroundHook` 通过 `ScheduledThreadPoolExecutorExt` 的 `beforeExecute`/`afterExecute` 钩子实现，在任务执行前后插入自定义逻辑（如性能监控、调试追踪等）。

## DispatchQueueImpl —— 并发原语

> 源码位置：zstack/core/src/main/java/org/zstack/core/thread/DispatchQueueImpl.java

`DispatchQueueImpl` 实现了三大并发原语，是 ZStack 并发控制的核心：

### 1. 同步任务队列（Sync Task Queue）

相同 `syncSignature` 的任务串行执行，不同 `syncSignature` 的任务并行执行：

```java
@Configurable(preConstruction = true, autowire = Autowire.BY_TYPE, dependencyCheck = true)
class DispatchQueueImpl implements DispatchQueue, DebugSignalHandler {
    private final HashMap<String, SyncTaskQueueWrapper> syncTasks = new HashMap<>();
    private final Map<String, ChainTaskQueueWrapper> chainTasks = Collections.synchronizedMap(new HashMap<>());
    private final Map<String, SingleFlightQueueWrapper> singleFlightTasks = Collections.synchronizedMap(new HashMap<>());
    private final Map<String, List<String>> apiRunningSignature = new ConcurrentHashMap<>();

    @Autowired
    ThreadFacade _threadFacade;
}
```

```java
@Override
public <T> Future<T> syncSubmit(SyncTask<T> task) {
    if (task.getSyncLevel() <= 0) {
        return _threadFacade.submitSyncPool(task);
    } else {
        return doSyncSubmit(task);
    }
}

private <T> Future<T> doSyncSubmit(final SyncTask<T> syncTask) {
    assert syncTask.getSyncSignature() != null : "How can you submit a sync task without sync signature ???";

    SyncTaskFuture f;
    synchronized (syncTasks) {
        SyncTaskQueueWrapper wrapper = syncTasks.get(syncTask.getSyncSignature());
        if (wrapper == null) {
            wrapper = new SyncTaskQueueWrapper();
            syncTasks.put(syncTask.getSyncSignature(), wrapper);
        }
        f = new SyncTaskFuture(syncTask);
        wrapper.addTask(f);
        wrapper.startThreadIfNeeded();
    }

    return f;
}
```

`SyncTaskQueueWrapper` 内部实现：

```java
private class SyncTaskQueueWrapper extends AbstractTaskQueueWrapper {
    ConcurrentLinkedQueue queue = new ConcurrentLinkedQueue();
    AtomicInteger counter = new AtomicInteger(0);
    int maxThreadNum = -1;

    void addTask(SyncTaskFuture task) {
        queue.offer(task);
        if (maxThreadNum == -1) {
            maxThreadNum = task.getSyncLevel();
        }
        if (syncSignature == null) {
            syncSignature = task.getSyncSignature();
        }
    }

    void startThreadIfNeeded() {
        if (counter.get() >= maxThreadNum) {
            return;
        }

        resetPendingQueueThreshold();
        counter.incrementAndGet();
        _threadFacade.submitTargetPool(new Task<Void>() {
            @Override
            public String getName() {
                return syncSignature;
            }

            void run() {
                SyncTaskFuture stask;
                while (true) {
                    while ((stask = (SyncTaskFuture) queue.poll()) != null) {
                        stask.run();
                    }

                    synchronized (syncTasks) {
                        if (queue.isEmpty()) {
                            if (counter.decrementAndGet() == 0) {
                                syncTasks.remove(syncSignature);
                            }
                            break;
                        }
                    }
                }
            }

            @Override
            public Void call() {
                run();
                return null;
            }
        }, syncSignature);
    }
}
```

**关键特性**：
- `syncLevel` 控制并发度：`syncLevel <= 0` 时直接提交到同步线程池，`syncLevel > 0` 时创建同步队列
- 同步队列中的线程循环消费任务，队列为空时线程退出
- 队列为空且无运行线程时，自动从 `syncTasks` Map 中移除
- 任务通过 `submitTargetPool()` 提交到对应签名的独立线程池

**应用场景**：CloudBus 的 `SyncLevel` 机制。当 Service 的 `syncLevel > 0` 时，发往该 Service 的消息通过同步队列串行处理。

### 2. 链式任务队列（Chain Task Queue）

链式任务保证同一 `syncSignature` 的任务按提交顺序执行，且前一个任务完成后才执行下一个：

```java
@Override
public Future<Void> chainSubmit(ChainTask task) {
    return doChainSyncSubmit(task);
}

private <T> Future<T> doChainSyncSubmit(final ChainTask task) {
    assert task.getSyncSignature() != null : "How can you submit a chain task without sync signature ???";
    DebugUtils.Assert(task.getSyncLevel() >= 1, "getSyncLevel() must return 1 at least ");

    synchronized (chainTasks) {
        final String signature = task.getSyncSignature();
        ChainTaskQueueWrapper wrapper = chainTasks.get(signature);
        if (wrapper == null) {
            wrapper = new ChainTaskQueueWrapper();
            chainTasks.put(signature, wrapper);
        }

        ChainFuture cf = new ChainFuture(task);
        boolean succeed = wrapper.addTask(cf, task.getMaxPendingTasks());
        if (!succeed) {
            cf.cancel();
            task.exceedMaxPendingCallback();
        } else {
            wrapper.startThreadIfNeeded();
        }
        return cf;
    }
}
```

`ChainFuture` 内部实现：

```java
class ChainFuture extends AbstractTimeStatisticFuture {
    private AtomicBoolean isNextCalled = new AtomicBoolean(false);

    public void run(final SyncTaskChain chain) {
        if (isCancelled()) {
            callNext(chain);
            return;
        }

        try {
            getTask().run(() -> {
                try {
                    done();
                } finally {
                    callNext(chain);
                }
            });
        } catch (Throwable t) {
            try {
                done();
            } finally {
                callNext(chain);
            }
        }
    }

    private void callNext(SyncTaskChain chain) {
        if (!isNextCalled.compareAndSet(false, true)) {
            return;
        }
        chain.next();
    }
}
```

`ChainTaskQueueWrapper` 内部实现：

```java
private class ChainTaskQueueWrapper extends AbstractTaskQueueWrapper {
    final LinkedList pendingQueue = new LinkedList();
    final LinkedList runningQueue = new LinkedList();
    AtomicInteger counter = new AtomicInteger(0);
    int maxThreadNum = -1;

    void startThreadIfNeeded() {
        if (counter.get() >= maxThreadNum) {
            return;
        }

        resetPendingQueueThreshold();
        counter.incrementAndGet();
        _threadFacade.submit(new Task<Void>() {
            @Override
            public String getName() {
                return "sync-chain-thread";
            }

            @AsyncThread
            private void runQueue() {
                ChainFuture cf;
                synchronized (chainTasks) {
                    cf = (ChainFuture) pendingQueue.poll();
                    if (cf == null) {
                        if (counter.decrementAndGet() == 0) {
                            chainTasks.remove(syncSignature);
                        }
                        return;
                    }
                }

                synchronized (runningQueue) {
                    processTimeoutTask(cf);
                    cf.setStartExecutionTimeInMills(zTimer.getCurrentTimeMillis());
                    runningQueue.offer(cf);
                }

                cf.run(() -> {
                    synchronized (runningQueue) {
                        runningQueue.remove(cf);
                    }
                    TaskContext.removeTaskContext();
                    runQueue();
                });
            }

            @Override
            public Void call() {
                runQueue();
                return null;
            }
        });
    }
}
```

**关键特性**：
- `syncLevel` 控制并发度：`syncLevel=1` 表示严格串行，`syncLevel=N` 表示最多 N 个任务并行
- 任务必须显式调用 `chain.next()` 才会执行下一个任务（通过 `SyncTaskChain` 回调）
- 如果任务抛出异常，自动调用 `chain.next()` 避免队列卡死
- `isNextCalled` 使用 `AtomicBoolean` 防止 `chain.next()` 被重复调用
- 支持 `maxPendingTasks` 限制待处理队列长度，超出时调用 `exceedMaxPendingCallback()`
- 使用 `@AsyncThread` 避免递归调用导致栈溢出

**应用场景**：CloudBusImpl3 的 HTTP 发送使用链式队列控制并发连接数。

### 3. SingleFlight 模式

SingleFlight 保证对同一个 `syncSignature` 的并发请求只执行一次，所有等待者共享同一次执行结果：

```java
@Override
public <T> Future<T> singleFlightSubmit(SingleFlightTask task) {
    return doSingleFlightSyncSubmit(task);
}

private <T> Future<T> doSingleFlightSyncSubmit(SingleFlightTask task) {
    assert task.getSyncSignature() != null : "How can you submit a single flight chain task without sync signature ???";

    synchronized (singleFlightTasks) {
        final String signature = task.getSyncSignature();
        SingleFlightQueueWrapper wrapper = singleFlightTasks.get(signature);
        if (wrapper == null) {
            wrapper = new SingleFlightQueueWrapper<T>();
            singleFlightTasks.put(signature, wrapper);
        }

        SingleFlightFuture sf = new SingleFlightFuture(task);
        wrapper.addSingleFlightTask(sf);
        wrapper.startSingleFlightIfNeed();
        return sf;
    }
}
```

`SingleFlightQueueWrapper` 内部实现（简化）：

```java
private class SingleFlightQueueWrapper<T> extends AbstractTaskQueueWrapper {
    LinkedList pendingQueue = new LinkedList();
    volatile SingleFlightFuture runningTask = null;
    AtomicInteger taskCounter = new AtomicInteger(0);

    void startSingleFlightIfNeed() {
        if (taskCounter.get() > 1) {
            return;
        }

        _threadFacade.submit(new Task<Void>() {
            @AsyncThread
            private void runSingleFlight() {
                synchronized (singleFlightTasks) {
                    if (runningTask != null) {
                        return;
                    }
                    runningTask = (SingleFlightFuture) pendingQueue.poll();
                    if (runningTask == null) {
                        singleFlightTasks.remove(syncSignature);
                        return;
                    }
                }

                runningTask.singleFlightRun(new ReturnValueCompletion<Object>(null) {
                    @Override
                    public void success(Object object) {
                        executeSingleRunTasks(object, null);
                    }

                    @Override
                    public void fail(ErrorCode errorCode) {
                        executeSingleRunTasks(null, errorCode);
                    }
                });
            }

            private void executeSingleRunTasks(Object object, ErrorCode errorCode) {
                synchronized (singleFlightTasks) {
                    safeRun(object, runningTask, errorCode);
                    pendingQueue.forEach(task -> safeRun(object, (SingleFlightFuture) task, errorCode));
                    taskCounter.set(0);
                    runningTask = null;
                    pendingQueue.clear();
                }
                runSingleFlight();
            }

            @Override
            public String getName() {
                return syncSignature;
            }

            @Override
            public Void call() {
                runSingleFlight();
                return null;
            }
        });
    }
}
```

**关键特性**：
- 同一时刻只有一个 `runningTask` 在执行
- 执行完成后，所有等待的 `pendingQueue` 中的任务共享同一结果
- `taskCounter` 用于判断是否需要启动新线程：`>1` 表示已有线程在运行
- 使用 `ReturnValueCompletion` 回调模式，支持异步执行

**应用场景**：防止对同一资源的并发操作重复执行。例如，多个 API 同时请求创建同一个 VM，SingleFlight 保证只执行一次创建操作。

## @AsyncThread 注解

> 源码位置：zstack/core/src/main/java/org/zstack/core/thread/AsyncThread.java

```java
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface AsyncThread {
}
```

`@AsyncThread` 是一个运行时注解，通过 AspectJ 编译时织入实现异步方法调用。标注了 `@AsyncThread` 的方法会在新线程中执行：

```java
// CloudBusImpl3 中的使用
private final Consumer<Event> eventConsumer = new Consumer<Event>() {
    @Override
    @AsyncThread
    public void accept(Event evt) {
        logger.debug(String.format("[event received]: %s", dumpMessage(evt)));
        Map<String, CloudBusEventListener> ls = eventListeners.get(evt.getType().toString());
        if (ls == null) return;
        ls.values().forEach(l -> callListener(evt, l));
    }
};
```

### AspectJ 织入

`@AsyncThread` 的织入逻辑在 `ThreadAspectj.aj` 中定义（AspectJ 文件）：

```java
pointcut asyncThreadExecution():
    execution(@org.zstack.core.thread.AsyncThread void *..*(..));

void around(): asyncThreadExecution() {
    ThreadFacadeImpl.instance.submit(new Runnable() {
        @Override
        public void run() {
            proceed();
        }
    });
}
```

当调用 `@AsyncThread` 标注的方法时，AspectJ 拦截调用，将方法体包装为 `Runnable` 提交到线程池异步执行。

## @ExceptionSafe 注解

```java
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface ExceptionSafe {
}
```

`@ExceptionSafe` 通过 AspectJ 织入，自动捕获方法抛出的异常并记录日志，避免异常传播导致线程终止：

```java
pointcut exceptionSafeExecution():
    execution(@org.zstack.core.thread.ExceptionSafe void *..*(..));

void around(): exceptionSafeExecution() {
    try {
        proceed();
    } catch (Throwable t) {
        logger.warn("unhandled exception in @ExceptionSafe method", t);
    }
}
```

在 DispatchQueueImpl 中的使用：

```java
@ExceptionSafe
private void processTimeoutTask(AbstractTimeStatisticFuture abstractTimeStatisticFuture) {
    ...
}
```

## JMX 监控

`ThreadFacadeImpl` 实现了 `ThreadFacadeMXBean` 接口，通过 JMX 暴露线程池统计信息：

```java
@Override
public ThreadPoolStatistic getThreadPoolStatistic() {
    long completedTask = _pool.getCompletedTaskCount();
    long pendingTask = _pool.getTaskCount() - completedTask;
    return new ThreadPoolStatistic(
            _pool.getPoolSize(),
            _pool.getActiveCount(),
            completedTask,
            pendingTask,
            _pool.getCorePoolSize(),
            _pool.getMaximumPoolSize(),
            _pool.getQueue().size()
    );
}

@Override
public void printThreadsAndTasks() {
    long completedTask = _pool.getCompletedTaskCount();
    long pendingTask = _pool.getTaskCount() - completedTask;

    long completedSyncTask = _syncpool.getCompletedTaskCount();
    long pendingSyncTask = _syncpool.getTaskCount() - completedSyncTask;

    StringBuilder builder = new StringBuilder();
    builder.append("check thread poolSize and tasks: ");
    builder.append(String.format("poolSize: %s, activeSize: %s, corePoolSize: %s, maximumPoolSize: %s, " +
            "completedTasks: %s, pendingTasks: %s, queueTasks: %s", _pool.getPoolSize(), _pool.getActiveCount(),
            _pool.getCorePoolSize(), _pool.getMaximumPoolSize(), completedTask, pendingTask, _pool.getQueue().size()));
    builder.append("check sync thread poolSize and tasks: ");
    builder.append(String.format("syncPoolSize: %s, activeSize: %s, coreSyncPoolSize: %s, maximumSyncPoolSize: %s, " +
                    "completedSyncTask: %s, pendingSyncTask: %s, queueSyncTasks: %s", _syncpool.getPoolSize(), _syncpool.getActiveCount(),
            _syncpool.getCorePoolSize(), _syncpool.getMaximumPoolSize(), completedSyncTask, pendingSyncTask,
            _syncpool.getQueue().size()));

    _logger.debug(builder.toString());
}
```

## Spring XML 配置

> 源码位置：zstack/conf/springConfigXml/ThreadFacade.xml

```xml
<bean id="ThreadFacade" class="org.zstack.core.thread.ThreadFacadeImpl">
    <!-- don't declare Component extension, it's specially handled -->
</bean>

<bean id="ThreadAspectj" class="org.zstack.core.aspect.ThreadAspect" factory-method="aspectOf" />

<bean id="TaskContextCleaner" class="org.zstack.core.thread.TaskContextCleaner "/>
```

**关键细节**：
- `ThreadFacade` bean 没有 `<zstack:plugin>` 扩展声明，有明确注释说明这是特殊处理
- 使用 `default-init-method="init"` 和 `default-destroy-method="destroy"` 管理生命周期
- `ThreadAspectj` 通过 `factory-method="aspectOf"` 获取 AspectJ 单例实例
- `TaskContextCleaner` 负责清理线程上下文

## 设计总结

| 设计决策 | 实现方式 | 优势 |
|---------|---------|------|
| 线程池统一管理 | `ScheduledThreadPoolExecutorExt` + 双池 | 同时支持定时任务和普通任务，避免无限制创建线程 |
| 自实现 ThreadFactory | `"zs-thread-"` 前缀 + 自增编号 | 线程名可辨识，便于日志排查 |
| 自实现 RejectedExecutionHandler | 记录警告日志 | 线程池满时明确告警 |
| 同步任务队列 | `SyncTaskQueueWrapper` + `syncSignature` | 相同签名串行，不同签名并行 |
| 链式任务队列 | `ChainFuture` + `SyncTaskChain` 回调 | 显式控制任务流转，支持并发度和队列长度限制 |
| SingleFlight | `SingleFlightQueueWrapper` + `ReturnValueCompletion` | 合并并发请求，避免重复执行 |
| @AsyncThread | AspectJ 编译时织入 | 声明式异步，零样板代码 |
| @ExceptionSafe | AspectJ 编译时织入 | 自动异常捕获，防止线程泄漏 |
| ThreadAroundHook | `ScheduledThreadPoolExecutorExt` 钩子 | 任务执行前后插入自定义逻辑 |
| JMX 监控 | `ThreadFacadeMXBean` | 运行时线程池状态可观测 |
| TimerPool | 5 个 `Timer` 轮询分配 | 避免单 Timer 瓶颈，支持超时任务 |
