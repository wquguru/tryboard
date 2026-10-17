// 旧关卡页（P0-21 下线）：跳转在 levels.html 的 <head> 里做（首帧前），这里只显示一行提示，跳转慢时可以手点。
export function App() {
  return (
    <main className="grid min-h-screen place-items-center px-4 text-[13px] leading-normal">
      <p>
        关卡已并入工作台的检查点。正在跳转到{' '}
        <a className="text-accent-ink underline" href="./app.html?work=weather#bench">
          实验台
        </a>
        …
      </p>
    </main>
  );
}
