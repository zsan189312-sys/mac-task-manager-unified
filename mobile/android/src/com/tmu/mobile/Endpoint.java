package com.tmu.mobile;
import java.net.URI;
final class Endpoint {
    static String validate(String raw) throws Exception {
        URI u=new URI(raw.trim());String h=u.getHost(),s=u.getScheme();
        if(h==null||u.getUserInfo()!=null||u.getQuery()!=null||u.getFragment()!=null||!(u.getPath()==null||u.getPath().isEmpty()||u.getPath().equals("/")))throw new Exception("请输入采集中心地址，例如 http://100.x.x.x:19100");
        boolean privateHost=false;
        if(h.equals("127.0.0.1")||h.equals("localhost"))privateHost=true;
        else if(h.matches("100\\.[0-9]+\\.[0-9]+\\.[0-9]+")){String[] parts=h.split("\\.");int b=Integer.parseInt(parts[1]),c=Integer.parseInt(parts[2]),d=Integer.parseInt(parts[3]);privateHost=b>=64&&b<=127&&c<=255&&d<=255;}
        if(!"https".equals(s)&&!("http".equals(s)&&privateHost))throw new Exception("HTTP 仅限 Tailscale 地址；其他地址请使用 HTTPS");
        return raw.trim().replaceAll("/+$","");
    }
}
