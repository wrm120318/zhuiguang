// vite.config.ts
import { defineConfig } from "file:///workspace/node_modules/vite/dist/node/index.js";
import vue from "file:///workspace/node_modules/@vitejs/plugin-vue/dist/index.mjs";
import AutoImport from "file:///workspace/node_modules/unplugin-auto-import/dist/vite.js";
import Components from "file:///workspace/node_modules/unplugin-vue-components/dist/vite.js";
import { ElementPlusResolver } from "file:///workspace/node_modules/unplugin-vue-components/dist/resolvers.js";
import path from "path";
var __vite_injected_original_dirname = "/workspace";
var vite_config_default = defineConfig({
  plugins: [
    vue(),
    AutoImport({ resolvers: [ElementPlusResolver()] }),
    Components({ resolvers: [ElementPlusResolver()] })
  ],
  resolve: {
    alias: { "@": path.resolve(__vite_injected_original_dirname, "src") }
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3001", changeOrigin: true },
      "/uploads": { target: "http://localhost:3001", changeOrigin: true }
    }
  },
  build: {
    cssCodeSplit: false,
    modulePreload: true,
    rollupOptions: {
      output: {
        manualChunks: {
          "element-plus-color-picker": ["element-plus/es/components/color-picker/index"],
          "element-plus-input-number": ["element-plus/es/components/input-number/index"],
          "element-plus-switch": ["element-plus/es/components/switch/index"]
        }
      }
    },
    // v2.1.1 - 禁用构建缓存，确保每次构建都生成新的 index.html
    sourcemap: false,
    emptyOutDir: true,
    manifest: false,
    // v2.1.14 - 添加 rollup 配置，避免 prompt() 问题
    chunkSizeWarningLimit: 1e3
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvd29ya3NwYWNlXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvd29ya3NwYWNlL3ZpdGUuY29uZmlnLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy93b3Jrc3BhY2Uvdml0ZS5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tICd2aXRlJ1xuaW1wb3J0IHZ1ZSBmcm9tICdAdml0ZWpzL3BsdWdpbi12dWUnXG5pbXBvcnQgQXV0b0ltcG9ydCBmcm9tICd1bnBsdWdpbi1hdXRvLWltcG9ydC92aXRlJ1xuaW1wb3J0IENvbXBvbmVudHMgZnJvbSAndW5wbHVnaW4tdnVlLWNvbXBvbmVudHMvdml0ZSdcbmltcG9ydCB7IEVsZW1lbnRQbHVzUmVzb2x2ZXIgfSBmcm9tICd1bnBsdWdpbi12dWUtY29tcG9uZW50cy9yZXNvbHZlcnMnXG5pbXBvcnQgcGF0aCBmcm9tICdwYXRoJ1xuXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoe1xuICBwbHVnaW5zOiBbXG4gICAgdnVlKCksXG4gICAgQXV0b0ltcG9ydCh7IHJlc29sdmVyczogW0VsZW1lbnRQbHVzUmVzb2x2ZXIoKV0gfSksXG4gICAgQ29tcG9uZW50cyh7IHJlc29sdmVyczogW0VsZW1lbnRQbHVzUmVzb2x2ZXIoKV0gfSlcbiAgXSxcbiAgcmVzb2x2ZToge1xuICAgIGFsaWFzOiB7ICdAJzogcGF0aC5yZXNvbHZlKF9fZGlybmFtZSwgJ3NyYycpIH1cbiAgfSxcbiAgc2VydmVyOiB7XG4gICAgaG9zdDogJzAuMC4wLjAnLCBwb3J0OiA1MTczLFxuICAgIHByb3h5OiB7XG4gICAgICAnL2FwaSc6IHsgdGFyZ2V0OiAnaHR0cDovL2xvY2FsaG9zdDozMDAxJywgY2hhbmdlT3JpZ2luOiB0cnVlIH0sXG4gICAgICAnL3VwbG9hZHMnOiB7IHRhcmdldDogJ2h0dHA6Ly9sb2NhbGhvc3Q6MzAwMScsIGNoYW5nZU9yaWdpbjogdHJ1ZSB9XG4gICAgfVxuICB9LFxuICBidWlsZDoge1xuICAgIGNzc0NvZGVTcGxpdDogZmFsc2UsXG4gICAgbW9kdWxlUHJlbG9hZDogdHJ1ZSxcbiAgICByb2xsdXBPcHRpb25zOiB7XG4gICAgICBvdXRwdXQ6IHtcbiAgICAgICAgbWFudWFsQ2h1bmtzOiB7XG4gICAgICAgICAgJ2VsZW1lbnQtcGx1cy1jb2xvci1waWNrZXInOiBbJ2VsZW1lbnQtcGx1cy9lcy9jb21wb25lbnRzL2NvbG9yLXBpY2tlci9pbmRleCddLFxuICAgICAgICAgICdlbGVtZW50LXBsdXMtaW5wdXQtbnVtYmVyJzogWydlbGVtZW50LXBsdXMvZXMvY29tcG9uZW50cy9pbnB1dC1udW1iZXIvaW5kZXgnXSxcbiAgICAgICAgICAnZWxlbWVudC1wbHVzLXN3aXRjaCc6IFsnZWxlbWVudC1wbHVzL2VzL2NvbXBvbmVudHMvc3dpdGNoL2luZGV4J10sXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9LFxuICAgIC8vIHYyLjEuMSAtIFx1Nzk4MVx1NzUyOFx1Njc4NFx1NUVGQVx1N0YxM1x1NUI1OFx1RkYwQ1x1Nzg2RVx1NEZERFx1NkJDRlx1NkIyMVx1Njc4NFx1NUVGQVx1OTBGRFx1NzUxRlx1NjIxMFx1NjVCMFx1NzY4NCBpbmRleC5odG1sXG4gICAgc291cmNlbWFwOiBmYWxzZSxcbiAgICBlbXB0eU91dERpcjogdHJ1ZSxcbiAgICBtYW5pZmVzdDogZmFsc2UsXG4gICAgLy8gdjIuMS4xNCAtIFx1NkRGQlx1NTJBMCByb2xsdXAgXHU5MTREXHU3RjZFXHVGRjBDXHU5MDdGXHU1MTREIHByb21wdCgpIFx1OTVFRVx1OTg5OFxuICAgIGNodW5rU2l6ZVdhcm5pbmdMaW1pdDogMTAwMCxcbiAgfVxufSlcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBZ04sU0FBUyxvQkFBb0I7QUFDN08sT0FBTyxTQUFTO0FBQ2hCLE9BQU8sZ0JBQWdCO0FBQ3ZCLE9BQU8sZ0JBQWdCO0FBQ3ZCLFNBQVMsMkJBQTJCO0FBQ3BDLE9BQU8sVUFBVTtBQUxqQixJQUFNLG1DQUFtQztBQU96QyxJQUFPLHNCQUFRLGFBQWE7QUFBQSxFQUMxQixTQUFTO0FBQUEsSUFDUCxJQUFJO0FBQUEsSUFDSixXQUFXLEVBQUUsV0FBVyxDQUFDLG9CQUFvQixDQUFDLEVBQUUsQ0FBQztBQUFBLElBQ2pELFdBQVcsRUFBRSxXQUFXLENBQUMsb0JBQW9CLENBQUMsRUFBRSxDQUFDO0FBQUEsRUFDbkQ7QUFBQSxFQUNBLFNBQVM7QUFBQSxJQUNQLE9BQU8sRUFBRSxLQUFLLEtBQUssUUFBUSxrQ0FBVyxLQUFLLEVBQUU7QUFBQSxFQUMvQztBQUFBLEVBQ0EsUUFBUTtBQUFBLElBQ04sTUFBTTtBQUFBLElBQVcsTUFBTTtBQUFBLElBQ3ZCLE9BQU87QUFBQSxNQUNMLFFBQVEsRUFBRSxRQUFRLHlCQUF5QixjQUFjLEtBQUs7QUFBQSxNQUM5RCxZQUFZLEVBQUUsUUFBUSx5QkFBeUIsY0FBYyxLQUFLO0FBQUEsSUFDcEU7QUFBQSxFQUNGO0FBQUEsRUFDQSxPQUFPO0FBQUEsSUFDTCxjQUFjO0FBQUEsSUFDZCxlQUFlO0FBQUEsSUFDZixlQUFlO0FBQUEsTUFDYixRQUFRO0FBQUEsUUFDTixjQUFjO0FBQUEsVUFDWiw2QkFBNkIsQ0FBQywrQ0FBK0M7QUFBQSxVQUM3RSw2QkFBNkIsQ0FBQywrQ0FBK0M7QUFBQSxVQUM3RSx1QkFBdUIsQ0FBQyx5Q0FBeUM7QUFBQSxRQUNuRTtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUE7QUFBQSxJQUVBLFdBQVc7QUFBQSxJQUNYLGFBQWE7QUFBQSxJQUNiLFVBQVU7QUFBQTtBQUFBLElBRVYsdUJBQXVCO0FBQUEsRUFDekI7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
