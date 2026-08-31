import { createApp } from "vue";
import { createPinia } from "pinia";
import Antd from "ant-design-vue";
import "ant-design-vue/dist/reset.css";
import App from "./App.vue";
import router from "./router";
import { bindAppRealtimeToSession } from "@/realtime/appBridge";
import "./style.css";

const app = createApp(App);
app.use(createPinia());
bindAppRealtimeToSession();
app.use(router);
app.use(Antd);
app.mount("#app");
