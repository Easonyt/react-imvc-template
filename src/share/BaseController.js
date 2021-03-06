// base controller class
import React, { Component } from "react";
import { createStore, createLogger } from "relite";
import * as _ from "./util";
import setRecorder from "./recorder";
import BaseView from "../component/BaseView";
import * as shareActions from "./actions";

/**
 * 绑定 Store 到 View
 * 提供 Controller 的生命周期钩子
 * 组装事件处理器 Event Handlers
 * 提供 fetch 方法
 */
export default class Controller {
  View = View;
  constructor(location, context) {
    this.location = location;
    this.context = context;
    this.handlers = {};
  }
  // 绑定 handler 的 this 值为 controller 实例
  combineHandlers(source) {
    let { handlers } = this;
    Object.keys(source).forEach(key => {
      let value = source[key];
      if (key.indexOf("handle") === 0 && typeof value === "function") {
        handlers[key] = value.bind(this);
      }
    });
  }

  prependBasename(pathname) {
    if (_.isAbsoluteUrl(pathname)) {
      return pathname;
    }
    let { locationOrigin, basename } = this.context;
    return locationOrigin + basename + pathname;
  }

  prependPublicPath(pathname) {
    if (_.isAbsoluteUrl(pathname)) {
      return pathname;
    }
    let { locationOrigin, publicPath } = this.context;
    return locationOrigin + publicPath + pathname;
  }

  // 处理 url 的相对路径或 mock 地址问题
  prependRestfulBasename = url => {
    let { context } = this;

    /**
		 * 如果已经是绝对路径
		 * 在服务端直接返回 url
		 * 在客户端裁剪掉 http: 使之以 // 开头
		 * 让浏览器自动匹配协议，支持 Https
		 */
    if (_.isAbsoluteUrl(url)) {
      if (context.isClient && url.indexOf("http:") === 0) {
        url = url.replace("http:", "");
      }
      return url;
    }

    // 对 mock 的请求进行另一种拼接，转到 node.js 服务去
    if (url.indexOf("/mock/") === 0) {
      return context.locationOrigin + context.basename + url;
    }

    return context.restfulApi + url;
  };

  /**
	* 封装重定向方法，根据 server/client 环境不同而选择不同的方式
	*/
  redirect(redirect, isReplace) {
    let { history, context } = this;

    if (context.isServer) {
      context.res.redirect(redirect);
    } else if (context.isClient) {
      if (_.isAbsoluteUrl(redirect)) {
        if (isReplace) {
          window.location.replace(redirect);
        } else {
          window.location.href = redirect;
        }
      } else {
        if (isReplace) {
          history.replace(redirect);
        } else {
          history.push(redirect);
        }
      }
    }
  }

  /**
	 * 封装 fetch, https://github.github.io/fetch
	 * options.json === false 不自动转换为 json
	 * options.timeout:number 超时时间
	 */
  fetch = (url, options = {}) => {
    let { context } = this;
    // 补全 url
    let finalUrl = this.prependRestfulBasename(url);

    let finalOptions = {
      method: "GET",
      credentials: "include",
      ...options,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        ...options.headers
      }
    };
    /**
		 * 浏览器端的 fetch 有 credentials: 'include'，会自动带上 cookie
		 * 服务端得手动设置，可以从 context 对象里取 cookie
		 */
    if (context.isServer) {
      finalOptions.headers["Cookie"] = context.cookie;
    }

    let fetchData = fetch(finalUrl, finalOptions);

    /**
		 * 拓展字段，如果手动设置 options.json 为 false
		 * 不自动 JSON.parse
		 */
    if (options.json !== false) {
      fetchData = fetchData.then(response => {
        // 如果 response 状态异常，抛出错误
        if (!response.ok || response.status !== 200) {
          return Promise.reject(new Error(response.statusText));
        }
        return response.json();
      });
    }

    let promiseList = [fetchData];

    /**
		 * 设置自动化的超时处理
		 */
    if (typeof options.timeout === "number") {
      let timeoutReject = new Promise((resolve, reject) => {
        setTimeout(
          () => reject(new Error(`Timeout Error:${options.timeout}ms`)),
          options.timeout
        );
      });
      promiseList.push(timeoutReject);
    }

    return Promise.race(promiseList);
  };
  /**
	 * 预加载 css 样式等资源
	*/
  fetchPreload = preload => {
    preload = preload || this.preload;
    let keys = Object.keys(preload);
    if (!preload || keys.length === 0) {
      return;
    }

    let { fetch, context } = this;
    let list = keys.map(name => {
      if (context.preload[name]) {
        return;
      }
      let url = preload[name];

      if (!_.isAbsoluteUrl(url)) {
        url = this.prependPublicPath(url);
      }

      let options = {
        json: false
      };
      return fetch(url, options).then(_.toText).then(content => {
        if (url.indexOf(".css") !== -1) {
          /**
						 * 如果是 CSS ，清空回车符
						 * 否则同构渲染时 react 计算 checksum 值会不一致
						 */
          content = content.replace(/\r+/g, "");
        }
        context.preload[name] = content;
      });
    });
    return Promise.all(list);
  };
  subscriber = data => {
    let { context, logger } = this;
    if (context.isServer) {
      return;
    }
    logger(data);
    this.refreshView();
    if (this.stateDidChange) {
      this.stateDidChange(data);
    }
  };
  async init() {
    let {
      initialState,
      getInitialState,
      actions,
      context,
      location
    } = this;

    let globalInitialState = undefined;

    // 服务端把 initialState 吐在 html 里的全局变量 __INITIAL_STATE__ 里
    if (typeof __INITIAL_STATE__ !== "undefined") {
      globalInitialState = __INITIAL_STATE__;
      __INITIAL_STATE__ = undefined;
    }
    let finalInitialState = {
      ...initialState,
      ...globalInitialState,
      location,
      isClient: context.isClient,
      isServer: context.isServer,
      publicPath: context.publicPath,
      restfulApi: context.restfulApi
    };

    /**
		 * 获取动态初始化的 initialState
		 */
    if (this.getInitialState) {
      finalInitialState = await this.getInitialState(finalInitialState);
    }

    // 对 api 里的路径进行补全
    if (finalInitialState.api) {
      finalInitialState.api = Object.keys(finalInitialState.api).reduce(
        (result, key) => {
          result[key] = this.prependRestfulBasename(finalInitialState.api[key]);
          return result;
        },
        {}
      );
    }

    /**
		 * 创建 store
		 */
    let finalActions = { ...shareActions, ...actions };
    let store = this.store = createStore(finalActions, finalInitialState);

    /**
		 * 将 handle 开头的方法，合并到 this.handlers 中
		 */
    this.combineHandlers(this);

    /**
		 * 如果存在 globalInitialState
		 * 说明服务端渲染了 html 和 intitialState
		 * component 已经创建
		 * 不需要再调用 shouldComponentCreate 和 componentWillCreate
		 */
    if (globalInitialState) {
      return this.bindStoreToView();
    }

    let promiseList = [];

    /**
		 * 如果 shouldComponentUpdate 返回 false，不创建和渲染 React Component
		 * 可以在 shouldComponentUpdate 里重定向到别的 Url
		 */
    if (this.shouldComponentCreate) {
      let result = await this.shouldComponentCreate();
      if (result === false) {
        return null;
      }
    }

    // 在 React Component 创建前调用，可以发 ajax 请求获取数据
    if (this.componentWillCreate) {
      promiseList.push(this.componentWillCreate());
    }

    /**
		 * 获取预加载的资源
		 */
    if (this.preload) {
      promiseList.push(this.fetchPreload());
    }

    if (promiseList.length) {
      await Promise.all(promiseList);
    }

    return this.bindStoreToView();
  }
  bindStoreToView() {
    let { context, store, location, View, history } = this;

    // bind store to view in client
    if (context.isClient) {
      this.logger = createLogger({
        name: this.name || location.pattern
      });
      let unsubscribeList = [];
      let unsubscribe = store.subscribe(this.subscriber);
      unsubscribeList.push(unsubscribe);

      // 监听路由跳转
      if (this.pageWillLeave) {
        let unlisten = history.listenBefore(this.pageWillLeave.bind(this));
        unsubscribeList.push(unlisten);
      }

      // 监听浏览器窗口关闭
      if (this.windowWillUnload) {
        let unlisten = history.listenBeforeUnload(
          this.windowWillUnload.bind(this)
        );
        unsubscribeList.push(unlisten);
      }

      this.unsubscribeList = unsubscribeList;

      setRecorder(store);
      window.scrollTo(0, 0);
    }

    let controller = this;

    // ViewWrapper 把 react 组件生命周期同步到 controller 里
    class ViewWrapper extends Component {
      componentWillMount() {
        if (controller.componentWillMount) {
          controller.componentWillMount();
        }
      }
      componentDidMount() {
        if (controller.componentDidMount) {
          controller.componentDidMount();
        }
      }
      componentWillUpdate(...args) {
        if (controller.componentWillUpdate) {
          controller.componentWillUpdate(...args);
        }
      }
      componentDidUpdate(...args) {
        if (controller.componentDidUpdate) {
          controller.componentDidUpdate(...args);
        }
      }
      shouldComponentUpdate(...args) {
        if (controller.shouldComponentUpdate) {
          let result = controller.shouldComponentUpdate(...args);
          return result === false ? false : true;
        }
        return true;
      }
      componentWillUnmount() {
        if (controller.componentWillUnmount) {
          controller.componentWillUnmount();
        }
      }
      render() {
        return <View {...this.props} />;
      }
    }

    this.ViewWrapper = ViewWrapper;

    return this.render();
  }
  destroy() {
    if (this.unsubscribeList) {
      this.unsubscribeList.forEach(unsubscribe => unsubscribe());
      this.unsubscribeList = null;
    }
  }
  handleInputChange = () => {};
  render() {
    let {
      ViewWrapper,
      store,
      handlers,
      location,
      history,
      context,
      handleInputChange
    } = this;
    let state = store.getState();
    let componentContext = {
      location,
      history,
      state,
      actions: store.actions,
      preload: context.preload,
      handleInputChange
    };
    return (
      <BaseView context={componentContext} key={location.raw}>
        <ViewWrapper state={state} handlers={handlers} />
      </BaseView>
    );
  }
}

function View() {
  return <noscript />;
}
